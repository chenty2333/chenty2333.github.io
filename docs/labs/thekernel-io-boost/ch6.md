# pin/unpin 与 user direct I/O

dirty run flush 处理的是**内核自己管理的页面**。本章处理的是生命周期更复杂的对象：**用户进程的页面**（user direct I/O）。

它复用 [ch4](#/labs/thekernel-io-boost/ch4) 中建立的 async block queue 契约。

## user direct I/O

### 问题：用户页的生命周期

用户程序调用 `read(fd, buf, len)` / `write(fd, buf, len)` 时，`buf` 是一个用户虚拟地址。内核拿到的只是一个地址值，背后的物理页面可能：

- 尚未分配（lazy allocation）
- 被 `munmap` 释放
- 被 `mprotect` 改变权限
- 被 `fork` 触发 COW（Copy-on-Write）
- 进程退出后被回收

如果要把用户页直接作为块设备请求的 data buffer——省掉中间 copy——就必须保证：**从 submit 到 completion 这段时间内，这些页面不能被释放、换出或复用。**

### pin 机制

**pin** 的含义是把一组页面在一段时间内固定住。被 pin 的页面在对应 guard 释放之前不会被内核回收。

```text
PinnedUserSlice      — 单段连续 pin（读方向）
PinnedUserSliceMut   — 单段连续 pin（写方向）
PinnedUserSegments   — 多段 SG pin
frame pin            — 物理页帧级别 pin
page-cache pin       — page cache page 的 pin（用于 file-backed mmap 场景）
```

这些 guard 跟着 block request slot 一起存活到 completion。completion drain 完成后才释放。这与 [ch4](#/labs/thekernel-io-boost/ch4) 的 owned request 是同一个问题——request、buffer、guard 的生命周期由队列闭合，不依赖调用者栈帧。

### fast path 与 fallback

**fast path**：用户地址满足对齐、权限、pin 条件时，直接将 pinned page slice 作为块设备请求的 segment。

**fallback**：地址不可访问、VMA 权限不匹配、缺页失败、不对齐、segment 过多、descriptor budget 不够等情况下，退回 `VmBytes` / `VmBytesMut` 受控用户拷贝接口。

fallback 是**正确路径**，不是错误路径。fallback 热时需要关注的是临时 buffer 的动态分配频率——每次 fallback 都走全局分配器申请 4KiB buffer 的话，在 1KB record 下会成为热点。

### 4KiB 阈值

user pin fast path 设有 4KiB 最低阈值。**1KB 的 iozone record 不会进入 pin 路径**。

原因：sub-4KiB 阈值实验（见 [ch3](#/labs/thekernel-io-boost/ch3)）导致总分 -2.49%，musl -5.66%。pin probe 的固定成本（地址检查、VMA 遍历、页表查询、guard 管理）在 1KB 粒度下重复上千次，超过省下的 copy 成本。计数器 `user_pin.to_user_attempts = 0` 确认 iozone workload 完全不触及 pin 路径。

### 信号与 completion 的交互

如果信号在 **submit 之前**到达，系统调用可以正常返回错误或短读写。

如果信号在 **submit 之后**到达，请求**不可取消**。设备已经拿到了 descriptor，安全做法是等请求完成后再将信号状态反映到返回路径。

> **不可取消原则**
>
> 已提交的设备请求必须运行到 completion，其 guard 才能释放。不能因为收到信号就提前释放 buffer——设备可能仍在读写那段内存。计数器 `user_pin.async_signal_after_submit` 记录这种情况。

### counter

```text
user_pin.async_direct_read_hits       — 读方向 fast path 命中
user_pin.async_direct_write_hits      — 写方向 fast path 命中
user_pin.async_submit_fallbacks       — fallback 到 copy 路径
user_pin.async_signal_after_submit    — submit 后收到信号
user_pin.async_resource_unpins        — unpin 操作计数
user_pin.page_cache_pin_hits          — file-backed mmap 场景的 page cache pin
```

RV Phase 7 实测：`read_hits = 7`，`write_hits = 3`，`submit_fallbacks = 322`。大部分 user I/O 仍走 fallback——因为 4KiB 阈值把 1KB iozone 排除在外。这符合预期。

user direct I/O 默认关闭（`user_direct_async_off`），需要显式开启。它应该在 dirty flush + full replay 通过之后再开启。

