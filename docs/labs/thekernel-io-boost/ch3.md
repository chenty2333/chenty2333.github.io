# async/batch block queue

本章介绍 TheKernel 块设备层的核心改造：从 submit one, wait one 的同步路径，变为支持多请求并发、异步完成的队列。

这个队列是后续所有 consumer（dirty flush、user direct I/O、lwext4 read path）的公共基础设施。它的设计围绕四个问题展开：

1. 请求对象放在哪、活多久？（**owned request**）
2. 一次能提交多少？（**descriptor budget admission**）
3. 完成后谁来收割？（**completion drain**）
4. 等待时怎么等？（**hybrid wait / IRQ-first**）

## 为什么同步路径不够

旧的 VirtIO 块设备接口：

```text
fn read_block(block_id, buf)  -> 提交 -> 忙等 -> 返回
fn write_block(block_id, buf) -> 提交 -> 忙等 -> 返回
```

调用者每次只允许一个请求在设备中。即使 VirtIO virtqueue 本身能容纳多个 descriptor，上层的 submit-then-busy-wait 模型把队列深度压死在 1。

旧路径中，请求的元数据（`BlkReq`、`BlkResp`、`done` flag）放在调用者的**栈**上。同步路径里这没有问题——函数不返回，栈变量一直活着。但如果要支持 batch submit（一次提交多个请求后再统一等待），函数可能在请求完成之前就要返回或去做别的事，栈变量此时已经失效。

## Phase 0–1：guardrail 与 capability API

改动从两条规则开始：

1. **Kill switch 先于功能**。在 `/proc/io_stats` 中加入 `async_block_on` / `async_block_off` 控制字，以及一组初始值为 0 的 counter。任何新路径默认关闭，出问题时一条 `echo async_block_off > /proc/io_stats` 即可回退到同步路径。
2. **Capability 而非 mandatory trait**。在 `axdriver_block` 中新增可选的 `AsyncBlockQueueOps` trait（含 `queue_caps`、`submit_batch`、`poll_complete`、`wait_all`、`fence`），`BlockDriverOps` 保持不变。不支持异步的设备返回 unsupported，调用方 fallback 到同步 `write_at` / `read_at`。

> **ADR 0009**
>
> 异步能力作为可选 capability 暴露，而非强制所有驱动重写。运行时 fallback 必须在任何 async 路径 default-on 之前存在。

## Phase 2：owned request pool（depth 1）

将栈上的 `PendingBlkRequest`（含裸指针指向调用者栈上的 `BlkReq`/`BlkResp`/`done`）替换为**队列拥有的 request slot**。

每个 slot 包含：

```text
BlkReq          — 设备请求头
BlkResp         — 设备响应
operation       — Read / Write / Flush
sector + len    — 扇区范围
segment metadata
completion state — Free / Prepared / Submitted / Completing / Done / Failed
token           — VirtIO used ring 中的标识
resource guard  — 持有 buffer / page pin / user pin 的 guard
```

request pool 大小固定（等于 VirtQueue size），不做热路径动态分配。提交时分配 slot、安装 token metadata；completion drain 时通过 token 找回 slot、读取 response、更新状态、释放 guard。

> **ADR 0005**
>
> 队列拥有请求对象。设备能访问的 request header、response、buffer 描述，都不能在 completion 前失效。debug build 中 drop 一个 live slot 会 panic。

Phase 2 保持 depth = 1，只做生命周期重写，不引入 batch。这样它可以独立于后续的批量提交逻辑进行验证——counter `virtio.blk_pending_max_depth = 1` + `resource_leaks = 0` 即为通过条件。

## Phase 3：descriptor-aware batch submit

### descriptor 成本

一个 VirtIO 块请求消耗的 descriptor 数量不固定：

```text
普通单 buffer 请求:  header(1) + data(1) + response(1) = 3
SG 多 segment 请求:  header(1) + segment_0 + segment_1 + ... + response(1) = 2 + N
```

因此 admission（准入控制）不能按「请求个数」限制，必须按 **descriptor budget**（描述符预算）限制。

### 提交流程

```text
1. drain 已完成请求（opportunistic completion drain）
2. 计算下一个 request 的 descriptor cost
3. 如果 slot 和 descriptor 都够 → add_unpublished（构建 descriptor chain 但不发布到 avail ring）
4. 安装 token metadata（在 publish 之前，防止 fast device 在 publish 瞬间完成时找不到对应 slot）
5. 对所有已 add 的请求统一 publish（更新 avail ring）
6. notify 设备（至多一次）
```

如果一批请求只能放下前缀，则提交前缀，剩余部分等 completion drain 后重试。计数器 `virtio.blk_async_admission_stalls` 记录这种情况。

### 架构差异

| | RISC-V | LoongArch64 |
|---|---|---|
| 默认深度 | 4 | 1（保守） |
| indirect descriptor | 可用 | 不假设可用 |
| event-idx | 可用 | 不假设可用 |
| descriptor budget | 16 | 16（direct split-ring 更贵） |

> **ADR 0002**
>
> RISC-V 是第一个性能目标；LoongArch64 是正确性目标——编译同一套代码、通过 smoke 和 replay，但默认保守深度，直到有正面性能证据。

## Phase 4：completion drain 与 hybrid wait

### completion drain

设备完成请求后将 used descriptor 放回 virtqueue。内核侧的 drain 流程：

```text
pop used token
  -> 通过 token 找到 owned request slot
  -> 读取 BlkResp
  -> 标记 Done 或 Failed
  -> 更新 counter
  -> 唤醒等待者
  -> 释放 resource guard（page pin / user pin / owned buffer）
```

drain 不由专门的 background worker 执行，而是从 **submit、wait、queue-full、interrupt** 四个入口 opportunistically 触发。

> **ADR 0007**
>
> 不引入常驻 completion worker。一个 background worker 会把忙轮询成本隐藏到另一个任务中，在 core queue contract 验证前不引入额外复杂性。

### hybrid wait

等待某个请求完成时的步骤：

```text
1. drain completions
2. 目标请求已完成？ -> 返回
3. 短暂 spin（继续 drain）
4. spin 超时仍未完成 -> 检查 can_block_current()
   4a. 可以 block -> 注册 WaitQueue waiter -> 再次检查（防 lost wakeup）-> sleep
   4b. 不可以 block -> bounded yield/spin -> 记录 fallback
5. 被 IRQ drain 或超时唤醒后回到步骤 1
```

> **为什么需要 `can_block_current()`**
>
> 部分 I/O 路径进入块设备等待时仍持有 preemption guard（例如 lwext4 的 `SpinNoPreempt` 文件系统锁）。在这种上下文中调用 `WaitQueue::wait_timeout_until` 会触发调度断言：`assertion failed: curr.can_preempt(2)`。因此 wait path 必须先判断当前上下文能否安全睡眠。

相关 counter：

```text
virtio.blk_async_wait_spins
virtio.blk_async_wait_spin_hits
virtio.blk_async_wait_yields
virtio.blk_async_wait_sleeps
virtio.blk_async_wait_wakeups
virtio.blk_async_wait_timeouts
```

这组 counter 的存在是为了证明一件事：**wait-poll CPU 成本没有从同步忙轮询简单移动到另一个无界 spin loop 中**。如果 `wait_sleeps` 和 `wait_wakeups` 为 0 而 `wait_spins` 很高，说明 hybrid wait 退化成了纯 spin，需要排查原因。

### IRQ-first（可选）

在 hybrid wait 基础上进一步：提交请求后如果平台中断可用，直接注册 waiter 然后 sleep，由设备中断触发 drain + wakeup。不依赖超时。

启用条件：

- block driver 注册了 IRQ handler
- handler 能 ack 中断并安全 drain
- 当前上下文 `can_block_current() == true`

当前默认策略保持 `async_block_wait=hybrid`。`irq_first` 作为显式 wait policy，通过 `/proc/io_stats` 切换，不默认开启——因为真实 filesystem consumer 的部分 wait 路径仍处于 cannot-block 上下文。

## barrier 与 flush 语义

异步写入不能打乱文件系统语义。需要区分两种边界：

| 操作 | 语义 |
|---|---|
| `fence_async()` | 等待已提交的 async data write 完成（数据到设备，但不保证持久化） |
| `flush()` | fence + 向设备提交 VirtIO FLUSH 请求（要求持久化到介质） |

普通 dirty data write 可以在同一 batch 内并发提交。但以下路径必须先 fence 再继续：

- `fsync` / `fdatasync` / `sync`
- close flush
- `truncate` / `unlink`
- metadata update
- journal-sensitive path

> **ADR 0008**
>
> 如果一条路径不能证明自己是「普通 dirty data writeback」，它就必须走同步路径。dirty page 的 dirty 标记只能在 completion **成功后**清除，不能在 submit 时清除。

## 回滚开关

所有行为通过 `/proc/io_stats` 运行时控制：

```text
async_block_on / async_block_off
async_block_depth=N
async_block_la_depth=N
async_block_wait=hybrid | sync | irq_first
async_dirty_flush_sg_on / async_dirty_flush_sg_off
async_block_adaptive_on / async_block_adaptive_off
async_block_merge_write_on / async_block_merge_write_off
```

每个 consumer 有独立开关。关闭某个 advanced feature 不影响已验证的 base queue——例如关闭 merge 后 SG4 固定 4-segment async write 仍然工作。

## 验证标准

核心 counter：

```text
virtio.blk_async_max_depth          >= 2   （真实队列深度）
virtio.blk_async_submit_batches     > 0    （batch 确实发生）
virtio.blk_async_completion_errors  = 0    （不可妥协）
virtio.blk_async_resource_leaks     = 0    （不可妥协）
```

`max_depth >= 2` 证明多个请求同时在队列中。`completion_errors` 和 `resource_leaks` 为 0 是硬性不可妥协条件——性能调优可以慢慢做，生命周期错误不能有。

RV smoke 实测 `max_depth = 4`；LA smoke 达到 `max_depth = 2`，但因性能未见提升而保持默认 depth = 1。

下一章介绍第一个接入这套队列的 consumer：page cache dirty run flush。
