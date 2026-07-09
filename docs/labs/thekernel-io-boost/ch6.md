# pin/unpin 与 user direct I/O

dirty run flush 的对象是内核页。user direct I/O 的对象是用户页，生命周期更复杂，同样走 [ch4](#/labs/thekernel-io-boost/ch4) 的 async block queue。

## 用户页生命周期

`read(fd, buf, len)` / `write(fd, buf, len)` 的 `buf` 是用户虚拟地址。背后物理页可能：

- 尚未分配（lazy allocation）
- 被 `munmap` 释放
- 被 `mprotect` 改权限
- `fork` 触发 COW
- 进程退出后被回收

用户页直接作块设备 data buffer 时，**submit 到 completion** 期间页不能被释放、换出或复用。

## pin

**pin** 把一组页面固定住，guard 释放前内核不回收。

```text
PinnedUserSlice      — 单段连续 pin（读）
PinnedUserSliceMut   — 单段连续 pin（写）
PinnedUserSegments   — 多段 SG pin
frame pin            — 页帧级 pin
page-cache pin       — file-backed mmap 场景
```

guard 跟 block request slot 活到 completion drain。request、buffer、guard 由队列闭合，同 [ch4](#/labs/thekernel-io-boost/ch4) owned request。

## fast path 与 fallback

**fast path**：地址对齐、权限和 pin 条件满足时，pinned slice 直接作 segment。

**fallback**：不可访问、VMA 不匹配、缺页失败、不对齐、segment 过多、descriptor budget 不够时，走 `VmBytes` / `VmBytesMut`。fallback 也是正确路径；热时关注每次 fallback 是否触发 4KiB 全局分配——1KB record 下会成为热点。

## 4KiB 阈值

user pin fast path 最低 4KiB。**1KB iozone record 不进 pin 路径**。

[ch3](#/labs/thekernel-io-boost/ch3) sub-4KiB 实验：总分 -2.49%，musl -5.66%。pin probe 固定成本（地址检查、VMA、页表、guard）在 1KB 粒度重复上千次，超过省下的 copy。`user_pin.to_user_attempts = 0`。

## 信号与 completion

信号在 **submit 前**到达：系统调用可正常返回错误或短读写。

信号在 **submit 后**到达：请求不能取消。设备已拿 descriptor，须等 completion 再把信号反映到返回路径。

> **submit 后不可取消**
>
> 已提交请求须跑到 completion 才释放 guard。`user_pin.async_signal_after_submit` 记这种情况。

## counter

```text
user_pin.async_direct_read_hits
user_pin.async_direct_write_hits
user_pin.async_submit_fallbacks
user_pin.async_signal_after_submit
user_pin.async_resource_unpins
user_pin.page_cache_pin_hits
```

RV Phase 7：`read_hits = 7`，`write_hits = 3`，`submit_fallbacks = 322`。大部分 user I/O 走 fallback——4KiB 阈值把 1KB iozone 挡在外面。

默认关（`user_direct_async_off`），显式开启。dirty flush 和 full replay 通过后再开。