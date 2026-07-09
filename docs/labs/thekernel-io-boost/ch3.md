# 被否决的实验

在 [ch1](#/labs/thekernel-io-boost/ch1) 确认瓶颈位于块设备层（depth=1、忙轮询）之前和之后，page cache、文件系统、readahead 策略、锁粒度等方向上做了大量实验。绝大多数被回滚。

本章按方向整理这些实验的**改法**、**测量结果**和**否决原因**。

## 基准与测量方法

所有实验使用同一套测量口径：

- **基准分数**（cap1024 no-stats baseline）：44.099（RV，musl 22.465 + glibc 21.634）
- **对比方式**：同一份 support image、同一版 `src/init.sh`、no-stats 模式
- **判定标准**：总分相对基准的百分比变化；musl / glibc 分项是否出现显著退化

> **no-stats 模式**
>
> 指运行时不开启 `/proc/io_stats` 的 VirtIO 诊断计数器。开启诊断时每次忙等轮询都会执行额外的原子递增，会干扰吞吐测量。性能判定必须在 no-stats 下完成。

---

## readahead 方向

readahead 方向有两个改动存活：**backward suppression**（反向抑制）和**可复用 scratch buffer**。其余七次尝试全部回滚。

### 存活：backward suppression

在 `ensure_page_cached_with()` 的 readahead 决策中加入方向判断：当前 miss 页号低于上一次 miss 时，只读取 1 页；否则保持完整的 64 页前向窗口。

```text
glibc/iozone-read-backwards page_cache_fill_read: 604.841 -> 282.272 ms
musl/iozone-read-backwards page_cache_fill_read:  441.760 -> 269.933 ms
```

反向扫描的 fill-read 减半。原因直观：反向访问时，预读 page N+1 到 N+63 的数据下次根本不会被用到（fill/block ratio 从 6.1 降到接近 1）。

### 存活：reusable readahead scratch buffer

`ensure_page_cached_with()` 中每次缓存未命中执行 `let mut buf = vec![0u8; ra * PAGE_SIZE];`——在**持有 page cache 锁**的情况下分配并清零一个 readahead 大小的临时缓冲区。改为 `CachedFileShared` 上挂一个 `Mutex<Vec<u8>>` 复用缓冲区，仅在容量增长时重新分配。

```text
glibc/iozone-random-read page_cache_fill_alloc: 1215.446 -> 3.722 ms
glibc/iozone-random-read page_cache_lock_hold:  2061.827 -> 722.448 ms
```

`fill_alloc` 从上千毫秒降到个位数，`lock_hold` 随之下降 30–76%。

### 否决：sequential readahead gate（两个变体）

在 `readahead_last_miss` 旁加入 `readahead_last_pages`，只在 miss 页号 == 上次 miss + 上次窗口时才给完整 64 页窗口，否则只读 1 页。

**变体 1**（所有 cold miss 给 1 页）：

```text
glibc/iozone-auto page_cache_fill_read: 199.260 -> 287.696 ms（退化）
musl/iozone-auto page_cache_fill_read:  211.780 -> 271.141 ms（退化）
```

**变体 2**（page-0 cold miss 给完整窗口）：

```text
glibc/iozone-read-backwards page_cache_flush: 40.526 -> 283.718 ms（退化）
musl/iozone-write-read page_cache_flush:      39.874 -> 248.790 ms（退化）
```

**否决原因**：单一的 last-miss 预测器太粗糙。收窄了 random-read 的 lock_hold，但把成本转移到了 sequential auto 和 flush-heavy 阶段。

### 否决：per-stream forward-random gate

把 predictor 从 inode 全局（`CachedFileShared`）移到每个打开流（`CachedFile`）上，加入前向随机跳跃检测——miss 页号远离上次 miss+window 时只读 1 页。

```text
glibc/iozone-auto page_cache_fill_read: 199.260 -> 288.889 ms（退化）
musl/iozone-read-backwards fill_read:   171.940 -> 556.876 ms（退化）
musl/iozone-write-read lock_hold:       836.765 -> 1117.889 ms（退化）
```

**否决原因**：更严格的前向门槛削弱了 sequential-sensitive 阶段的有用预读，musl 退化严重。

### 否决：per-stream backward predictor ownership

不改策略，只把 `readahead_last_miss` 的所有权从 inode 全局移到 per-stream。

```text
glibc/iozone-read-backwards fill_read:  186.561 -> 424.722 ms（退化）
musl/iozone-read-backwards fill_read:   171.940 -> 479.581 ms（退化）
glibc/iozone-read-backwards lock_hold: 1124.446 -> 1568.322 ms（退化）
```

**否决原因**：仅移动所有权就导致大幅退化。inode 全局的 predictor history 对跨 open 的 read-backward/write-read 行为是 load-bearing 的——"纯安全改进"的假设不成立。

### 否决：persistent readahead history（FileUserData）

让 predictor 存活于 page cache Arc 的生命周期之外——将 `readahead_last_miss` 改为 `Arc<AtomicU32>` 存入 `FileUserData`，page cache 释放后仍保留 history。

```text
reopen-backward elapsed: ~1.50s -> 0.33–0.35s
musl/io-pattern-reopen-backward fill_read: 443.767 -> 44.251 ms
```

目标指标大幅改善，但 `bb sync`（全局同步）挂死——QEMU 超时。

**否决原因**：把读侧 hint 耦合到了 file-cache registry（全局 sync 会遍历/prune 的数据结构）。能让 sync 挂死的内核改动不可接受。

### 否决：readahead history sidecar

修复上一个的 sync 问题：将 history 移到独立的 `BTreeMap<(device, inode), last_miss_page>`，与 file registry 解耦。

```text
glibc/iozone-read-backwards fill_read（stressed）: 282.272 -> 424.569 ms（退化）
```

**否决原因**：修好了 hang，但 iozone phase 矩阵复现了和 per-stream ownership 相同的 glibc/read-backwards 退化。predictor ownership 和 lock-held outer-window 的尾延迟耦合在一起，目前无法安全改动。

### 否决：in-flight miss coalescing / 单页 fill

对同一页的并发 miss 做合并等待（`CachedFileShared::clean_read_inflight`），同时把 fill 从 64 页 readahead 缩减为单页。

```text
page_cache_inflight_wait count = 0（所有 iozone phase 行）
glibc/iozone-auto fill_read: 199.260 -> 480.457 ms（退化）
glibc/iozone-auto block_read: 153.821 -> 404.682 ms（退化）
```

**否决原因**：评测环境是 single-HART 串行模型（smp=1），根本不会产生同页并发 miss——`inflight_wait` 计数器始终为 0。同时砍掉了 sequential readahead，fill_read 和 block_read 翻倍退化。

---

## lock 方向

ch1 的 profiler 归因显示 page cache 锁内的残差很大（`lock_hold` 1400+ ms，已归因的 fill_insert / read_copy / flush_prepare 加起来才几百 ms）。自然的想法是收窄锁范围。两次尝试都失败了。

### 否决：miss-read outside lock

对 clean cache miss，在锁内做 plan，释放锁后读 scratch buffer，重新拿锁后插入（如果期间没有其他任务填充同一页）。

```text
glibc/iozone fill_read: 1076.889 -> 908.760 ms（改善）
musl/iozone fill_read:   785.802 -> 1216.356 ms（退化）
glibc/iozone flush:      538.355 -> 957.201 ms（退化）
```

**否决原因**：glibc 改善但 musl 大幅退化，flush 路径也恶化。smoke 通过但 full-iozone 矩阵不稳定。根因在于 120ms fill-read 停顿是 runnable-but-off-CPU 时间，不是真正的磁盘 I/O 时间——收窄锁解决不了调度问题。

### 否决：flush outside lock

给 dirty state 加版本号（per-PageCache atomic id + per-page dirty generation），在锁内快照一批连续脏页后释放锁，锁外执行 `file.write_at`，重新拿锁后只有 id+generation 匹配才 clear dirty。额外处理了 append/write 互斥、`set_len` 参与、`direct_io_lock.write()` 包装、内部 drain helper 防自死锁。

```text
musl/iozone-read-backwards lock_hold:  867.459 -> 1411.920 ms（退化）
musl/iozone-read-backwards fill_read:  171.940 ->  304.091 ms（退化）
musl/iozone-read-backwards flush:       62.225 ->  224.752 ms（退化）
```

review 过程中发现 public `drain/invalidate` 和 `set_len()` 存在 stale-snapshot 竞态，full-iozone 运行中途 abort（Error 130）。

**否决原因**：释放锁后页可能被替换或重新标脏，越修补需要的锁越多，最终 lock_hold 不降反升。flush 路径的锁范围不是根因——和 miss-read 同理，问题在调度层。

---

## 环境约束方向

### 否决：in-flight miss coalescing（single-HART）

这条在 readahead 方向已经提到，但它更本质的否决原因属于环境约束：评测环境是 **single-HART serial evaluator**（smp=1）。

设计意图是对同一页的并发 miss 做合并等待，减少重复读盘。但串行环境下，同一时刻只有一个任务在执行 page cache fill——不会产生"同一页的并发 miss"。`page_cache_inflight_wait` 计数器在所有 iozone phase 行中始终为 0。

这个约束还影响了其他设计决策：per-inode 锁收窄（下一节）的收益也受限于同样的原因——单核串行时，inode 间读并发本身就不存在。

---

## 其它方向

### 否决：1KB pending 聚合

在 page cache 层做单页 pending 缓冲——维护 4-bit 1KiB 覆盖掩码，四个 chunk 凑齐后一次提交，跳过旧页读取。

```text
RV musl:  161917 -> 138857  (-14.24%)
RV glibc: 167426 -> 149805  (-10.52%)
```

命中率很高（`cached.write_pending_rewrite_chunks` = 60276），但总分大幅退化。

**否决原因**：跳过的旧页读取并不是瓶颈。额外的 per-1KiB 栈拷贝和 pending 锁状态维护的成本超过了省下的磁盘读。请求流已经合并到 ~135KiB/个，在 1KiB 粒度上省一次旧页读取没有意义。

### 否决：lazy partial-rewrite valid-prefix

为每个 page cache 页维护 valid-prefix 字节偏移，对前缀写入或超出旧 EOF 的写入跳过旧页读取，缺失字节延迟到读取时从磁盘补齐。

| 架构/libc | 变化 |
|---|---|
| RV musl | -1.0% |
| RV glibc | +4.8% |
| LA musl | +0.2% |
| LA glibc | -5.2% |

**否决原因**：valid-prefix 的簿记和 lazy materialize 的分支成本在 1KiB workload 下过高，尤其对 LoongArch64。收益跨架构不一致。

### 否决：CRC32c unroll-by-8

在 `ext4_crc32.c` 的 `crc32()` 表查询辅助中做 unroll-by-8 展开。

总分 44.112（+0.03%），musl -2.19%，glibc +2.34%。

**否决原因**：收益在噪声范围内。目标 ISA 为 `rv64imafdch`，不含 Zbc/Zbkc 扩展——如果 emit 了 carry-less-multiply 指令会触发非法指令异常。

### 否决：降低 FILE_IO_COOPERATE_INTERVAL

将文件 I/O 路径中强制 `axtask::yield_now()` 的间隔从 4096 提高到 16384。

总分 44.129（+0.07%），musl 退化 -2.54%。

**否决原因**：让出 CPU 的频率已经足够低，继续降低没有收益。

### 否决：scheduler-yield 注入 VirtIO 等待循环

在 `virtio-drivers` 的忙等循环中每 256 次轮询后调用 `axtask::yield_now()`。

**结果**：QEMU 超时，内核未输出到 kernel prompt。

**否决原因**：底层块设备等待循环的上下文可能持有各种锁或 preemption guard，直接 yield 导致调度死锁。正确做法是在更高层将 submit 和 wait 分离（[ch4](#/labs/thekernel-io-boost/ch4)）。

### 否决：sub-4KiB user pin 阈值

将 user-pin 路径的最低阈值从 4KiB 放宽到 1KiB。

```text
总分: 44.099 -> 43.002 (-2.49%)
musl: -5.66%
```

**否决原因**：1KiB record 下 pin probe 的固定开销（地址检查、VMA 查询、页表遍历、pin guard 管理）重复上千次，超过了省下的 copy。4KiB 阈值正是让 1KiB workload 完全不进入 pin 路径——计数器 `user_pin.to_user_attempts = 0` 确认了这一点。

### 否决：retained closed-file cache 4096 页

将关闭文件后保留的 page cache 页上限从 1024 提高到 4096。

总分 43.861（-0.54%）。read 行有改善（被 score cap 截断），write 行退化。

**否决原因**：加大缓存让读行提升被计分上限截断，同时挤占了写路径的内存预算，净效果为负。

### 否决：naive 4KiB chunk batch submit

将大的连续 `read_block` / `write_block` buffer 拆为多个 4KiB chunk，一次 publish 多个到 VirtIO virtqueue，notify 一次后 drain。

smoke 中计数器确认机制工作（`blk_pending_max_depth = 4`），但 no-stats 正式 replay 卡死在 `iozone automatic measurements`。

**否决原因**：把一个本已连续的大请求切碎确实创造了队列深度，但破坏了 iozone 路径的性能形态。正确方向是让上层天然产生的多个请求（dirty flush、readahead）同时进入队列——这是 [ch4](#/labs/thekernel-io-boost/ch4) 的设计。

### 否决：per-inode 锁收窄 / 无锁 mapped read

在 axfs-ng 中引入 64 个 inode 分片锁；在 lwext4 中加入 `DirectReadPlan`——锁内快照 written 4KiB extents 后释放锁，通过克隆 handle 做无锁读取。

总分 44.015（-0.19%）。

**否决原因**：额外的 extent-planning pass 加 device mutex 没有带来吞吐收益。1KiB workload 的瓶颈不在 inode 间读并发——block 完成和队列深度才是限制因素（smp=1 串行执行）。

### 否决：fill-insert zero-tail

缓存未命中插入新页时，先拷贝 file.read_at 返回的字节，再只清零尾部（`data[n0..]` / `data[len..]`），而不是整页先清零再拷贝。

```text
glibc/iozone-write-read fill_insert: 244.136 -> 16.261 ms（改善）
musl/iozone-write-read lock_hold:    492.141 -> 1161.713 ms（退化）
musl/iozone-read-backwards lock_hold: 869.161 -> 1485.646 ms（退化）
```

**否决原因**：目标指标在部分行大幅改善，但 musl 的 lock-hold 和 fill-read 整体退化严重。需要先做 zero-fill context attribution 确认清零开销的来源分布后再尝试。

### 否决：flush window 512

将 `MAX_DIRTY_WRITEBACK_PAGES` 从 256 进一步提高到 512（1 MiB → 2 MiB 单次 flush write）。

```text
glibc/iozone page_cache_flush:   538.355 -> 769.867 ms（退化）
musl/iozone page_cache_fill_read: 785.802 -> 1072.018 ms（退化）
```

**否决原因**：flush 事件数减少了（73→63），但总等待时间不降反升。musl fill-read 也退化。保持 256 作为保守窗口。

> **存活的 flush 优化**：将 `MAX_DIRTY_WRITEBACK_PAGES` 从 64 提高到 256 是存活的改动——flush count 从 277 降到 73，`block_write` 从 53ms 降到 38ms。512 是在此基础上的过度推进。

---

## 小结

这些实验覆盖了 readahead 策略、page cache 锁范围、环境约束适配、缓存策略、块设备等待策略、用户页 pin 阈值等方向。共同特征：

1. 块请求流**已经充分合并**（~168KiB 读，~135KiB 写）。在 1KiB 粒度上继续做合并或省读没有有效收益。
2. 队列深度**锁死在 1**。无论上层怎么优化，最终到块设备都是 submit one, wait one。
3. 120ms fill-read 停顿的真正来源是 **runnable-but-off-CPU**（调度），不是磁盘或文件系统时间。两次 lock 收窄失败正是因为它们解决的是错误的问题。
4. 评测环境为 **single-HART serial**，所有依赖多核并发的优化（miss coalescing、inode 间并行读）在当前环境下无效。

两个存活的改动（backward suppression + reusable scratch buffer）针对的是真实的浪费：无用预读和重复分配。它们不试图解决 depth=1 问题——那是 [ch4](#/labs/thekernel-io-boost/ch4) 的工作。
