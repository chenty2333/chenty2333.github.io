# async/batch block queue

[ch1](#/labs/thekernel-io-boost/ch1) 定位到块设备层后，改造目标是把 submit one, wait one 换成支持多请求并发、异步完成的队列。dirty flush、user direct I/O、lwext4 read path 都走这套基础设施。

四个要解决的问题：**owned request** 放哪、活多久；**descriptor budget admission** 一次提交多少；**completion drain** 谁收割完成；**hybrid wait / IRQ-first** 怎么等。

## 同步路径

旧 VirtIO 块设备接口：

```text
fn read_block(block_id, buf)  -> 提交 -> 忙等 -> 返回
fn write_block(block_id, buf) -> 提交 -> 忙等 -> 返回
```

调用者每次只允许一个请求在设备里。virtqueue 能容纳多个 descriptor，上层 submit-then-busy-wait 把深度压在 1。

`BlkReq`、`BlkResp`、`done` 放在调用者栈上。同步路径函数不返回，栈变量一直有效。batch submit 时函数可能在 completion 前返回，栈变量会失效。

## Phase 0–1：guardrail 与 capability API

两条起始规则：

1. **Kill switch 先于功能**。`/proc/io_stats` 加 `async_block_on` / `async_block_off` 和一组 counter。新路径默认关，`echo async_block_off > /proc/io_stats` 可回退同步路径。
2. **Capability 而非 mandatory trait**。`axdriver_block` 新增可选 `AsyncBlockQueueOps`（`queue_caps`、`submit_batch`、`poll_complete`、`wait_all`、`fence`），`BlockDriverOps` 不变。不支持异步的设备返回 unsupported，调用方 fallback 到 `write_at` / `read_at`。

> **ADR 0009**
>
> 异步能力可选暴露；运行时 fallback 必须在 async default-on 之前存在。

## Phase 2：owned request pool（depth 1）

栈上 `PendingBlkRequest`（裸指针指向栈上 `BlkReq`/`BlkResp`/`done`）换成队列拥有的 request slot。

每个 slot：

```text
BlkReq          — 设备请求头
BlkResp         — 设备响应
operation       — Read / Write / Flush
sector + len    — 扇区范围
segment metadata
completion state — Free / Prepared / Submitted / Completing / Done / Failed
token           — VirtIO used ring 标识
resource guard  — buffer / page pin / user pin
```

pool 大小固定（VirtQueue size），热路径不动态分配。提交时分配 slot、装 token；drain 时按 token 找回 slot、读 response、释放 guard。

> **ADR 0005**
>
> 队列拥有请求对象。completion 前 header、response、buffer 描述不能失效。debug build 里 drop live slot 会 panic。

Phase 2 保持 depth = 1，只做生命周期，不引入 batch。`virtio.blk_pending_max_depth = 1` 且 `resource_leaks = 0` 即过。

## Phase 3：descriptor-aware batch submit

### descriptor 成本

```text
普通单 buffer:  header(1) + data(1) + response(1) = 3
SG 多 segment:  header(1) + segment_0 + ... + response(1) = 2 + N
```

admission 按 **descriptor budget** 限制，不能只看请求个数。

### 提交流程

```text
1. opportunistic completion drain
2. 算下一个 request 的 descriptor cost
3. slot 和 descriptor 够 → add_unpublished（建 chain，暂不发布 avail ring）
4. 装 token metadata（publish 前，防 fast device 瞬间完成找不到 slot）
5. 统一 publish
6. notify（至多一次）
```

一批只能放下前缀时，提交前缀，其余等 drain 后重试。`virtio.blk_async_admission_stalls` 记这种情况。

### 架构差异

| | RISC-V | LoongArch64 |
|---|---|---|
| 默认深度 | 4 | 1 |
| indirect descriptor | 可用 | 不假设 |
| event-idx | 可用 | 不假设 |
| descriptor budget | 16 | 16 |

> **ADR 0002**
>
> RV 是性能目标；LA 是正确性目标——同一套代码、smoke 和 replay 通过，默认保守深度，直到有正面性能证据。

## Phase 4：completion drain 与 hybrid wait

### completion drain

```text
pop used token
  -> 找 owned request slot
  -> 读 BlkResp
  -> 标 Done / Failed
  -> 更新 counter
  -> 唤醒等待者
  -> 释放 resource guard
```

从 submit、wait、queue-full、interrupt 四个入口 opportunistically drain，无常驻 worker。

> **ADR 0007**
>
> 不引入常驻 completion worker。core queue contract 验证前，worker 只会把忙轮询藏到别的任务里。

### hybrid wait

```text
1. drain completions
2. 目标已完成？→ 返回
3. 短暂 spin（继续 drain）
4. spin 超时 → 查 can_block_current()
   4a. 可 block → WaitQueue waiter → 再查（防 lost wakeup）→ sleep
   4b. 不可 block → bounded yield/spin，记 fallback
5. IRQ drain 或超时唤醒后回到 1
```

> **can_block_current()**
>
> 部分路径持 preemption guard（如 lwext4 `SpinNoPreempt`）。此上下文调 `WaitQueue::wait_timeout_until` 会触发 `assertion failed: curr.can_preempt(2)`。wait path 须先判断能否睡眠。

```text
virtio.blk_async_wait_spins
virtio.blk_async_wait_spin_hits
virtio.blk_async_wait_yields
virtio.blk_async_wait_sleeps
virtio.blk_async_wait_wakeups
virtio.blk_async_wait_timeouts
```

`wait_sleeps` / `wait_wakeups` 为 0 而 `wait_spins` 很高时，hybrid wait 退化成纯 spin。

### IRQ-first（可选）

平台中断可用时：提交后注册 waiter → sleep，中断触发 drain + wakeup。

须 block driver 有 IRQ handler、handler 能 ack 并 drain、`can_block_current() == true`。

默认 `async_block_wait=hybrid`。`irq_first` 经 `/proc/io_stats` 显式切换——filesystem consumer 的部分 wait 路径仍 cannot-block。

## barrier 与 flush 语义

| 操作 | 语义 |
|---|---|
| `fence_async()` | 等已提交的 async data write 完成（到设备，不保证持久化） |
| `flush()` | fence + VirtIO FLUSH（要求持久化） |

普通 dirty data write 可同 batch 并发提交。以下路径须先 fence：

- `fsync` / `fdatasync` / `sync`
- close flush
- `truncate` / `unlink`
- metadata update
- journal-sensitive path

> **ADR 0008**
>
> 不能证明自己是普通 dirty data writeback 的路径走同步。dirty 标记只在 completion 成功后清，submit 时不能清。

## 回滚开关

`/proc/io_stats` 运行时控制：

```text
async_block_on / async_block_off
async_block_depth=N
async_block_la_depth=N
async_block_wait=hybrid | sync | irq_first
async_dirty_flush_sg_on / async_dirty_flush_sg_off
async_block_adaptive_on / async_block_adaptive_off
async_block_merge_write_on / async_block_merge_write_off
```

每个 consumer 独立开关。关 merge 后 SG4 固定 4-segment async write 仍可用。

## 验证

```text
virtio.blk_async_max_depth          >= 2
virtio.blk_async_submit_batches     > 0
virtio.blk_async_completion_errors  = 0
virtio.blk_async_resource_leaks     = 0
```

`max_depth >= 2` 表示多请求同时在队列。`completion_errors` 和 `resource_leaks` 为 0 不可妥协。

RV smoke：`max_depth = 4`。LA smoke：`max_depth = 2`，性能未见提升，默认 depth 保持 1。