# I/O 路径与 iozone

## iozone 测的是什么

**iozone** 是一个文件系统 **benchmark**。它用 `read`、`write`、`pread`、`pwrite`、`preadv`、`pwritev` 等标准接口对文件做读写，测量整条文件 I/O 路径的吞吐。

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

iozone 的分数反映整条链路的端到端性能，不是其中任何单独一层。

测试参数：

| 参数 | 值 | 含义 |
|---|---|---|
| 线程数 | 4 | 并发执行者 |
| 文件大小 | 1MB | 每线程一个文件 |
| record 大小 | 1KB | 单次 I/O 操作的数据量 |

**record** 是 iozone 中每次 `read`/`write` 搬运的字节数。1KB record 下，1MB 文件约需 1000 次系统调用。

> **1KB record**
>
> 路径上每一层都有固定成本：临时分配、`memcpy`、块映射查询、设备等待。大 record 时这些成本被摊薄；1KB 时固定成本与数据搬运几乎等量，每一层的 per-op 开销都会暴露出来。

## 建立观测能力

iozone 分数低可能来自系统调用、page cache、文件系统元数据、块设备提交与等待——仅凭分数无法区分。

TheKernel 加了 **I/O profiler**，挂在 `/proc/io_prof`，统计 I/O 系统调用次数、字节数，以及块设备诊断计数器。

profiler 要求：

> **观测不能扰动被观测对象**
>
> 评测机读 stdout 打分。profiler **默认全关**；关闭时热路径只做一次 `AtomicU8` Relaxed load，处于 `LEVEL_OFF` 即返回——不分配、不格式化、不计数。显式 `echo on > /proc/io_prof/control` 后才开始记录。

开启后，profiler 只在系统调用**成功返回路径**上做一次原子递增，记录点在 `Ok(...)`，字节数等于实际传输量。

## 定位问题

### 块请求大小

VirtIO 块设备层收到的请求，平均大小为：

```text
读请求 ≈ 168 KiB / 个
写请求 ≈ 135 KiB / 个
```

1KB 用户操作经 readahead 和写回攒批后，到块设备已是合并后的大块。请求碎片化不是问题。

### 队列深度

```text
virtio.blk_pending_max_depth = 1
```

**queue depth** 是「已提交、等待完成」请求的峰值。VirtIO **virtqueue** 可容纳多个并发请求，但计数器显示任意时刻最多 **1** 个。

块设备路径是 **submit one, wait one**：

```text
提交请求 -> 忙等完成 -> 返回 -> 提交下一个 -> 忙等完成 -> 返回 -> ...
```

### 等待方式

```text
queue_sync_wait_polls ≈ 49,885,014
```

等待循环是 `while (未完成) { 轮询; }`，一次诊断自旋约 5000 万次。

队列深度为 1，等待靠纯忙轮询——块设备层值得往下查。page cache、ext4 是否也有贡献，靠下面的归因拆开。

## profiler 归因

我们做了如下工作，排除一些可能的原因。

### page_cache_lock_hold

压测下 `page_cache_lock_hold` 数值很高：

```text
musl/iozone-random-read  page_cache_lock_hold:  778 ms（baseline）→ 1544 ms（stressed）
musl/iozone-random-read  page_cache_lock_wait:  3.3 ms → 66.5 ms
```

`lock_wait` 加压后飙升，存在 **convoy**——多任务排队等同一把锁。

### 锁内簿记

把 `lock_hold` 按持锁子操作拆开：

```text
glibc/iozone-write-read（stressed）:
  page_cache_lock_hold    = 1406 ms
  page_cache_fill_insert  =  244 ms
  page_cache_read_copy    =  144 ms
  page_cache_flush_prepare =    9 ms
```

分配、拷贝、LRU 插入、刷脏准备加起来只有几百毫秒，和 1406ms 的 `lock_hold` 对不上。残差在别处。

### ext4

残差主要在 `page_cache_fill_read`（缓存 miss 读页）。往下加 ext4 计数器：

```text
glibc/iozone-read-backwards（stressed）:
  page_cache_fill_read  = 311.9 ms
  fs_ext4_read          =  70.8 ms（仅占 23%）
  ext4_fs_lock_wait     =  < 1 ms
```

`ext4_fs_lock_wait < 1ms`，direct block read 紧贴 `block_read`。

max gap：

```text
musl/iozone-random-read:
  fill_read_max  = 120.098 ms
  fs_read_max    =   0.437 ms
  max_gap        = 119.661 ms（fs 只解释了 0.4%）
```

120ms 停顿里 ext4/块设备/virtqueue 只占不到 0.5ms，119ms 在 page cache 持锁的「外层窗口」。

### off-CPU

加入 **scoped off-CPU profiler**，只在 `page_cache_fill_read` 活跃期间记录 off-CPU 时间，区分 `sched_ready_off_cpu` 和 `sched_blocked_off_cpu`：

```text
musl/iozone-read-backwards:
  fill_read_max                          = 120.170 ms
  fs_read_max                            =   0.350 ms
  page_cache_fill_read_sched_ready_off_cpu  max = 119.988 ms（count 2，total 239.909 ms）
  page_cache_fill_read_sched_blocked_off_cpu    = 0
```

120ms 里文件系统读只占 0.35ms，**119ms 是 runnable 但被调度出去**——没在等 I/O，只是没拿到 CPU。page cache 锁、ext4、锁内簿记这几项可以放下；时间和 depth=1、submit 后被动等待对得上。

### 锁内 scratch buffer 分配

`ensure_page_cached_with()` 在 cache miss 时，**持 page cache 锁**执行：

```rust
let mut buf = vec![0u8; ra * PAGE_SIZE];
```

`page_cache_fill_alloc` 计数器加上后，`lock_hold` 残差归零：

```text
glibc/iozone-read-backwards:  page_cache_fill_alloc = 1402 ms
```

可复用 scratch buffer 的修复见 [ch3](#/labs/thekernel-io-boost/ch3)。`lock_hold` 里也有和锁竞争无关的成本，收窄锁解决不了。

## 接下来

把块设备层从 submit one, wait one 改成能容纳多请求并发、异步完成的 **async/batch block**。

涉及请求生命周期、**VirtIO descriptor** 预算、**completion drain**、等待路径能否安全睡眠——见 [ch4](#/labs/thekernel-io-boost/ch4)。[ch2](#/labs/thekernel-io-boost/ch2) 是当时的计划，[ch3](#/labs/thekernel-io-boost/ch3) 是并行做的上层实验。