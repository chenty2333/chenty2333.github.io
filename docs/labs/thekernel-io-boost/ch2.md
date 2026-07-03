# 被否决的上层优化实验

在确认瓶颈位于块设备层之前，我们在上层（page cache、文件系统、缓存策略、用户缓冲区路径）尝试了大量优化方案。绝大多数最终被回滚。

本章整理其中有代表性的几组实验，记录每一组的**改法**、**测量结果**和**否决原因**。它们共同指向一个结论：当块请求流已经充分合并、而队列深度锁死在 1 时，在上层继续做 1KB 级别的状态优化不会产生有效收益。

## 基准与测量方法

所有实验使用同一套测量口径：

- **基准分数**（cap1024 no-stats baseline）：44.099（RV，musl 22.465 + glibc 21.634）
- **对比方式**：同一份 support image、同一版 `src/init.sh`、no-stats 模式
- **判定标准**：总分相对基准的百分比变化；musl / glibc 分项是否出现显著退化

> **no-stats 模式**
>
> 指运行时不开启 `/proc/io_stats` 的 VirtIO 诊断计数器。开启诊断时每次忙等轮询都会执行额外的原子递增，会干扰吞吐测量。性能判定必须在 no-stats 下完成。

## 1KB pending 聚合

**改法**：在 page cache 层面做单页 pending 缓冲——持有一个 inode 局部的 4KiB 页，维护 4-bit 1KiB 覆盖掩码。只接受对已有完整页的精确 1KiB 对齐重写，等四个 chunk 凑齐后一次提交，跳过旧页读取。

**结果**：

```text
RV musl:  161917 -> 138857  (-14.24%)
RV glibc: 167426 -> 149805  (-10.52%)
```

计数器显示命中率很高（`cached.write_pending_rewrite_chunks` = 60276），但总分大幅退化。

**否决原因**：跳过的旧页读取并不是瓶颈。额外的 per-1KiB 栈拷贝、pending 锁状态维护、以及对 page cache 原有 readahead 路径的干扰，合计成本超过了省下的磁盘读。在请求流已经合并到 ~135KiB/个的情况下，在 1KiB 粒度上省一次旧页读取没有意义。

## lazy partial-rewrite valid-prefix 追踪

**改法**：为每个 page cache 页维护一个 valid-prefix 字节偏移，记录该页从头开始有多少字节已经是有效数据。对于前缀写入或超出旧 EOF 的写入，跳过旧页读取，缺失字节延迟到读取时再 materialize（从磁盘补齐）。

**结果**：

| 架构/libc | 变化 |
|---|---|
| RV musl | -1.0% |
| RV glibc | +4.8% |
| LA musl | +0.2% |
| LA glibc | -5.2% |

进一步收窄为「仅 page-prefix 或 beyond-old-EOF」的变体，LA glibc 仍退化 -2.7%。

**否决原因**：valid-prefix 的簿记和 lazy materialize 的分支成本在 1KiB workload 下过高，尤其对 LoongArch64。收益不稳定、跨架构不一致，不满足接受标准。

## CRC32c 字节循环展开

**改法**：在 `ext4_crc32.c` 的共享 `crc32()` 表查询辅助函数中做 unroll-by-8 展开。

**结果**：总分 44.112（+0.03%），musl -2.19%，glibc +2.34%。

**否决原因**：总收益在噪声范围内，musl 退化。且本地 QEMU 报告的 ISA 为 `rv64imafdch`，不含 Zbc/Zbkc 扩展。如果 emit 了 carry-less-multiply 指令，在当前目标上会触发非法指令异常。CRC 优化保留为未来 `+zbc/+zbkc` flavor 的 gated feature，不动默认代码。

## 降低 FILE_IO_COOPERATE_INTERVAL

**改法**：将文件 I/O 路径中强制 `axtask::yield_now()` 的间隔从 4096 次提高到 16384 次，减少协作调度的频率。

**结果**：总分 44.129（+0.07% vs 基准，-1.34% vs VirtIO pending 样本）。

**否决原因**：未改善目标路径，musl 退化 -2.54%。让出 CPU 的频率已经足够低，继续降低没有收益。

## scheduler-yield 注入 VirtIO 等待循环

**改法**：在 `virtio-drivers` 的 `wait_for_pending_done` 忙等循环中，每 256 次轮询后调用一次 `axtask::yield_now()`，期望让出 CPU 给其他任务。

**结果**：QEMU 超时，内核未输出到 kernel prompt。

```text
qemu-system-riscv64: terminating on signal 15 ... (timeout 320s)
```

**否决原因**：在底层块设备等待循环中直接调用调度器不是安全的中断等待策略。该上下文可能持有各种锁或 preemption guard，直接 yield 导致调度死锁或无限等待。正确做法是在更高层（文件系统 / page cache 层）将 submit 和 wait 分离，而非在 VirtIO 驱动内部注入调度。

## sub-4KiB user pin 阈值

**改法**：将 user-pin（用户页零拷贝）路径的最低阈值从 4KiB 放宽到 1KiB，让 iozone 的 1KB record 也能走 pin fast path。

**结果**：

```text
总分: 44.099 -> 43.002  (-2.49%)
musl: 22.465 -> 21.193  (-5.66%)
glibc: +0.81%
```

pin 命中很多，但总分显著退化。

**否决原因**：1KiB record 下 pin probe 的固定开销（地址检查、VMA 查询、页表遍历、pin guard 管理）重复上千次，超过了省下的那一次 copy。4KiB 阈值存在的意义正是让官方 1KiB workload 完全不进入 pin 路径——计数器 `user_pin.to_user_attempts = 0` 确认了这一点。

## 更宽的 retained closed-file cache（4096 页）

**改法**：将关闭文件后保留的 page cache 页上限从 1024 提高到 4096，期望提升重读命中率。

**结果**：总分 43.861（-0.54%）。部分 read 行有改善（已被 score cap 限制），部分 write 行退化。

**否决原因**：加大缓存使读行提升被计分上限截断，同时挤占了写路径的内存预算，净效果为负。保持 1024 页。

## naive 4KiB chunk batch submit

**改法**：将大的连续 `read_block` / `write_block` buffer 拆分为多个 4KiB chunk，一次 publish 多个到 VirtIO virtqueue 中，notify 一次，再 drain。

**结果**：smoke 中计数器确认机制工作（`virtio.blk_pending_max_depth = 4`，`blk_requests = 1586`，`queue_full = 0`）。但 no-stats 正式 replay 卡死在 `iozone automatic measurements`。

**否决原因**：把一个本已连续的大请求拆成多个 4KiB 小请求确实创造了队列深度，但破坏了 iozone 路径的性能形态和 liveness 特性。正确方向是让上层天然产生的多个请求（来自 dirty flush、readahead 等）同时进入队列，而不是人为把一个请求切碎。

## per-inode 锁收窄 / 无锁 mapped read

**改法**：在 axfs-ng 中引入 64 个 inode 分片锁；克隆 ext4 disk wrapper 到 device mutex 后面；在 lwext4 中加入 `DirectReadPlan`——在全局锁内快照 written 4KiB extents 后释放锁，通过克隆 handle 做无锁读取。

**结果**：总分 44.015（-0.19%）。

**否决原因**：额外的 extent-planning pass 加 device mutex 没有带来吞吐收益。1KiB workload 的瓶颈不在 inode 间读并发——因为 block 完成和队列深度才是限制因素。锁收窄只是把序列化点从一处挪到另一处，增加了规划开销。

## 小结

这些实验覆盖了 page cache 状态优化、文件系统缓存策略、块设备等待策略、用户页 pin 阈值、锁粒度等多个方向。它们的共同特征是：

1. 块请求流**已经充分合并**（~168KiB 读，~135KiB 写）。在 1KiB 粒度上继续做合并或省读没有有效收益。
2. 队列深度**锁死在 1**。无论上层怎么优化，最终到块设备都是 submit one, wait one。上层优化触碰不到这个瓶颈。
3. 几个试图在块设备层内部制造深度的尝试（scheduler-yield、naive 4KiB batch）都因为绕过了正确的生命周期管理而失败。

正确的下一步是构建一套完整的**异步块设备队列**，从 owned request、descriptor 预算、completion 收割、hybrid wait 开始做起。下一章展开这个引擎的设计与实现。
