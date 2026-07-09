# I/O 路径与 iozone

## iozone 测的是什么

**iozone** 是一个文件系统 **benchmark**（基准测试程序）。它用 `read`、`write`、`pread`、`pwrite`、`preadv`、`pwritev` 等标准接口对文件做读写，测量整条文件 I/O 路径的吞吐。

一次文件读写会穿过多个层次：

```text
用户程序 read/write/pread/pwrite/...
  -> 系统调用层
  -> VFS / 文件对象
  -> page cache
  -> 文件系统（ext4 / lwext4）
  -> 块设备层
  -> VirtIO 块设备
```

iozone 的分数反映的是**这条完整链路的端到端性能**，而不是其中任何单独一层。

我们的测试参数：

| 参数 | 值 | 含义 |
|---|---|---|
| 线程数 | 4 | 并发执行者 |
| 文件大小 | 1MB | 每线程一个文件 |
| record 大小 | 1KB | 单次 I/O 操作的数据量 |

**record** 是 iozone 中每次调用 `read`/`write` 时搬运的字节数。1KB 的 record 意味着一个 1MB 文件需要经过约 1000 次系统调用才能读/写完成。

> **1KB record 为什么能暴露问题**
>
> 路径上每一层都有**固定成本**：一次临时内存分配、一次 `memcpy`、一次块映射查询、一次设备请求的等待。大 record（例如 1MB）时这些固定成本被摊薄到很多字节中；1KB record 时，固定成本和实际数据搬运的成本几乎等量。这正是 1KB record 的压力所在——它会把每一层的**每次操作固定开销**完整暴露出来。

## 建立观测能力

iozone 分数低可以由很多原因导致：系统调用开销、page cache 效率、文件系统元数据查询、块设备层的提交和等待方式。仅凭分数无法区分。

为了定位瓶颈，我们在 TheKernel 中加入了 **I/O profiler**（I/O 性能剖析器），挂载在 `/proc/io_prof`，可以统计各类 I/O 系统调用的次数、字节数，并提供块设备层的诊断计数器。

profiler 有一条设计约束：

> **观测不能扰动被观测对象**
>
> TheKernel 在自动评测环境中运行，评测机读取 stdout 打分。profiler **默认全关**，关闭时热路径上仅执行一次 `AtomicU8` 的 Relaxed load，发现处于 `LEVEL_OFF` 后立即返回——不分配内存、不格式化字符串、不触碰任何计数器。只有显式 `echo on > /proc/io_prof/control` 之后才开始记录。

开启后，profiler 只在系统调用的**成功返回路径**上做一次原子递增。记录点在最终的 `Ok(...)` 上，保证记录到的字节数等于实际传输的字节数，且记录动作不改变系统调用的返回语义。

## 数据给出的答案

在 profiler 的帮助下，我们关注两组关键数据。

### 块请求大小：已经够大

VirtIO 块设备层实际收到的请求，平均大小为：

```text
读请求 ≈ 168 KiB / 个
写请求 ≈ 135 KiB / 个
```

用户态的 1KB 小操作，经过 page cache 的 readahead（预读）与写回攒批之后，到达块设备时已经被合并成了大块。**请求碎片化并不是当前瓶颈**——上层的合并工作已经做得相当充分。

### 队列深度：只有 1

```text
virtio.blk_pending_max_depth = 1
```

**队列深度（queue depth）** 是块设备队列中同时处于「已提交、等待完成」状态的请求数的峰值。VirtIO 本身支持在 **virtqueue** 中同时容纳多个请求，设备可以并行处理。但这个计数器显示：无论任何时刻，队列中最多只有 **1** 个请求。

这意味着当前的块设备路径是严格的 **submit one, wait one**（提交一个，等一个）：

```text
提交请求 -> 忙等完成 -> 返回 -> 提交下一个 -> 忙等完成 -> 返回 -> ...
```

设备的并行能力从未被利用。

### 等待方式：纯忙轮询

```text
queue_sync_wait_polls ≈ 49,885,014
```

等待方式是 `while (未完成) { 轮询; }`，一次诊断运行中自旋了约 5000 万次。CPU 时间大量消耗在这个循环中，而非数据搬运。

## profiler 逐层归因

以上数据（depth=1、忙轮询 5000 万次）是最终结论。在得到这个结论之前，profiler 经过了一段逐层收窄的归因过程。这个过程本身也值得记录，因为它逐一排除了几个看似合理的嫌疑方向。

### 第一层：page cache 锁是最大的 wait

压测下最突出的计数器是 `page_cache_lock_hold`——page cache 每 inode 锁被持有的总时长：

```text
musl/iozone-random-read  page_cache_lock_hold:  778 ms（baseline）→ 1544 ms（stressed）
musl/iozone-random-read  page_cache_lock_wait:  3.3 ms → 66.5 ms
```

锁等待（`lock_wait`）在加压后飙升，说明存在真实的 **convoy（护航）效应**——多个任务排队等同一把锁。

### 第二层：锁里的簿记工作很小

把 `lock_hold` 按持锁期间的子操作拆开归因：

```text
glibc/iozone-write-read（stressed）:
  page_cache_lock_hold    = 1406 ms
  page_cache_fill_insert  =  244 ms
  page_cache_read_copy    =  144 ms
  page_cache_flush_prepare =    9 ms
```

分配、拷贝、LRU 插入、刷脏准备加起来只占一小部分。剩余一千多毫秒的**残差**不知道花在哪里。持锁期间并没有在做繁重的簿记——问题不在"锁里的活太重"。

### 第三层：ext4 被洗清

残差主要落在 `page_cache_fill_read`——缓存未命中时把文件页读进来的那一步。它是持锁期间的最大开销。自然的怀疑是：底下的 ext4 文件系统或磁盘慢。

继续向下加归因计数器，进入 ext4 内部：

```text
glibc/iozone-read-backwards（stressed）:
  page_cache_fill_read  = 311.9 ms
  fs_ext4_read          =  70.8 ms（仅占 23%）
  ext4_fs_lock_wait     =  < 1 ms
```

ext4 的全局锁几乎不等（< 1ms）。ext4 的 direct block read 时间紧贴 `block_read`（块设备层时间）。**ext4 不是瓶颈**——fill_read 的大头不在它下面。

进一步看 max gap（单次最坏停顿）：

```text
musl/iozone-random-read:
  fill_read_max  = 120.098 ms
  fs_read_max    =   0.437 ms
  max_gap        = 119.661 ms（fs 只解释了 0.4%）
```

最坏的一次 fill_read 停顿有 120ms，但 ext4/块设备/virtqueue 只解释了其中不到 0.5ms。剩下的 119ms 消失在 page cache 持锁的"外层窗口"里。

### 第四层（决定性）：off-CPU

为了搞清楚那 119ms 去了哪里，加入 **scoped off-CPU profiler**：只在 `page_cache_fill_read` 活跃期间，记录当前任务被调度出去的时间，并区分 `sched_ready_off_cpu`（runnable 但没轮到）和 `sched_blocked_off_cpu`（真的阻塞在 I/O 上）。

```text
musl/iozone-read-backwards:
  fill_read_max                          = 120.170 ms
  fs_read_max                            =   0.350 ms
  page_cache_fill_read_sched_ready_off_cpu  max = 119.988 ms（count 2，total 239.909 ms）
  page_cache_fill_read_sched_blocked_off_cpu    = 0
```

120ms 的停顿里，真正花在文件系统读上的只有 0.35ms。剩下的 **119ms 是"runnable 但被调度出去"**——任务没在等 I/O，只是没拿到 CPU。

这个结果排除了磁盘、文件系统、锁里的活等所有嫌疑。时间花在请求提交后的被动等待上——和 `blk_pending_max_depth = 1` 的结论完全一致。

### 附带发现：锁内 scratch buffer 分配

归因过程中还定位到 `lock_hold` 残差的一个具体来源。`ensure_page_cached_with()` 中每次缓存未命中执行：

```rust
let mut buf = vec![0u8; ra * PAGE_SIZE];
```

在**持有 page cache 锁的状态下**分配并清零一个 readahead 大小的 scratch buffer。加入 `page_cache_fill_alloc` 计数器后，残差归零：

```text
glibc/iozone-read-backwards:  page_cache_fill_alloc = 1402 ms
```

这个问题后来通过可复用 scratch buffer 修复（详见 [ch3](#/labs/thekernel-io-boost/ch3)），但它本身也印证了一点：`lock_hold` 这个大数字里藏着各种和"锁竞争"无关的东西，不能简单地靠"收窄锁"来解决。

## 瓶颈定位小结

| 层 | 证据 | 结论 |
|---|---|---|
| 请求大小 | 读 ~168KiB，写 ~135KiB | 已充分合并，不是瓶颈 |
| ext4 元数据锁 | `ext4_fs_lock_wait < 1ms` | 洗清 |
| ext4 direct read | 紧贴 `block_read` | 洗清 |
| page cache 锁内分配 | `fill_alloc` 1402ms | 真问题，可单独修复 |
| **队列深度** | 峰值 = 1 | **根因**：设备并行未被利用 |
| **等待方式** | 纯忙轮询 ~5000 万次 + off-CPU 119/120ms | **根因**：CPU 时间浪费在被动等待 |

瓶颈在**块设备层**：深度只有 1，请求提交后只能同步忙等或被动 off-CPU，无法让多个请求的等待重叠。

## 接下来的方向

目标明确：把块设备层从 submit one, wait one 改造为能容纳多个并发请求、支持异步完成的 **async/batch block queue**（异步批量块设备队列）。

这件事涉及：**请求对象的生命周期管理**、**VirtIO descriptor（描述符）预算控制**、**completion（完成）收割机制**、**等待路径能否安全睡眠**等一系列问题。它们将在 [ch4](#/labs/thekernel-io-boost/ch4) 展开。

不过在动手写队列之前，有必要先交代两件事：一是最初的优化计划押注在什么方向上（[ch2](#/labs/thekernel-io-boost/ch2)），二是那份计划里的大量尝试为什么最终被否决（[ch3](#/labs/thekernel-io-boost/ch3)）。这两章的内容和上面的归因过程在时间上是交叉进行的。
