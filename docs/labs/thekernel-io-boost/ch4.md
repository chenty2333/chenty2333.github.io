# page cache dirty run flush

page cache dirty run flush 是第一个接入 async/batch block queue 的 consumer。选择它作为第一个 consumer 的原因：**dirty page 由内核管理，生命周期比用户页简单得多**，同时它会真实经过文件系统和块设备的写入路径，能检验队列契约是否正确。

## dirty page 从哪来

用户调用 `write(fd, buf, len)` 时，数据通常不会立刻落盘。内核先将用户数据写入 **page cache** 中对应的文件页，然后把该页标记为 **dirty**（已修改但尚未写回磁盘）。

```text
write(fd, buf, len)
  -> CachedFile::write_at
  -> 找到或创建 page cache page
  -> copy 用户数据到 cache page
  -> page.dirty = true
  -> 返回用户态
```

后续在 `fsync`、文件关闭、缓存压力、显式 flush 等时机，dirty page 才被写回文件系统和块设备。

iozone 的 write / rewrite / random write / pwrite / pwritev 都会不断制造 dirty page。1KB record 下写入次数极多，page cache 中同一批页面反复被写脏。写入本身只是前半段；后半段是 dirty page **怎么刷回去**。

## 逐页 flush 的问题

最直接的 flush 方式——逐页写回：

```text
dirty page 0 -> write_at(offset=0, 4096)    -> block submit -> wait
dirty page 1 -> write_at(offset=4096, 4096)  -> block submit -> wait
dirty page 2 -> write_at(offset=8192, 4096)  -> block submit -> wait
dirty page 3 -> write_at(offset=12288, 4096) -> block submit -> wait
```

语义正确，但性能差。这些页在文件偏移上连续，底层磁盘 block 很可能也连续，逐页 flush 却把它们拆成多个独立的 4KB 小请求，每个都要走一次文件系统映射、块设备提交、completion 等待。

**dirty run flush** 的做法：先识别连续 dirty page 组成的 **run**（连续区间），再按 run 为单位提交。

```text
dirty page 0..3 (连续)
  -> 合并为一次 write_at(offset=0, 16384)
  -> block batch submit
```

## Phase 5A：owned buffer 语义验证

第一版 dirty run flush 没有直接把 page cache page 交给块设备，而是先将 dirty run **拷贝到内核拥有的 writeback buffer** 中。

流程：

```text
拿 page-cache lock
  -> 扫描连续 dirty page
  -> 拷贝数据到 owned writeback buffer（16-page / 64KiB segments）
  -> 记录 page number / offset / len
释放 page-cache lock
  -> file.write_at_vectored(...)   [通过 async batch queue]
  -> wait all completions
重新检查 page 状态
  -> completion 成功 -> 清 dirty
  -> completion 失败 -> 保留 dirty
```

这一步仍有一次 copy，但它解决了两个关键问题：

**锁的持有时间**：块设备 I/O 需要等待 completion，等待期间不能持有 page-cache map lock，否则其他读写、缓存回收、truncate 全部被阻塞。Phase 5A 在锁内只收集数据和元信息，提交 I/O 前释放锁。

**buffer 生命周期**：owned buffer 由 flush 路径自己持有，提交给块设备后不会被 page cache 回收，也不会被并发写入修改。设备完成前 buffer 始终有效。

> **Phase 5A 的定位**
>
> 它是一个**语义验证阶段**，暂时保留 copy，先证明：
> - 连续 dirty page 能形成 run
> - run 可以进入 vectored write
> - async block queue 能接住这些请求
> - dirty 标记只在 completion 成功后清除
> - completion 失败时 dirty 状态保留
>
> 这一层不稳的话，直接做零拷贝只会让 bug 更难查。

实测 counter：`cached.async_dirty_flush_hits = 51`，`async_dirty_flush_pages = 1689`，`async_dirty_flush_bytes ≈ 6.86 MB`，`virtio.blk_async_max_depth = 4`。

## Phase 5B：page-cache SG 零拷贝

Phase 5B 去掉 copy，把 page cache page 直接作为块设备请求的 data segment 提交。

**SG**（scatter-gather）指多个不连续的内存段作为一组 segment 提交给设备。page cache 中的连续文件页在物理内存上不一定连续，但可以用多个 segment 描述。

流程：

```text
扫描连续 dirty page（>= 2 页、完整页、无 evict listener、未处于 writeback）
  -> pin pages（阻止 LRU 逐出）
  -> mark writeback
  -> 构建 SG segments
  -> async vectored write（通过 block queue）
  -> completion
  -> clear dirty / clear writeback / unpin
```

### writeback 状态的作用

一个 page 正在写回（writeback）时，如果并发写入直接覆盖然后 flush 路径清掉 dirty，会丢失数据：

| 时间 | 事件 | 结果 |
|---|---|---|
| t1 | flush 提交 page 内容 A | 设备开始写 A |
| t2 | 并发 write 将 page 改为 B | 内存中是 B |
| t3 | flush completion 成功 | dirty 被清除 |
| t4 | — | 内存中是 B，磁盘上是 A，dirty = false → B 丢失 |

解决方式：正在 writeback 的 page 被标识出来，并发写入需要等待 writeback 结束或在 writeback 后重新标记 dirty。

### SG4 chunk 限制

Phase 5B 最初将整个 dirty run 映射为一个大 SG 请求（all-segments）。在 RV QEMU 下产生了 queue-full、admission stall 和 `cached.async_dirty_flush_errors`。

接受的形态是 **SG4**：每个 async request 最多携带 4 个 data segment。请求数从 320（每页一个请求）→ 160（SG2）→ **80**（SG4）。

> **为什么不用 indirect descriptor**
>
> indirect descriptor 可以让一个请求携带任意多 segment 而只消耗 1 个 virtqueue descriptor。但 indirect 的 DMA 行为和 descriptor accounting 在 LoongArch64 上尚未充分验证。SG4 保守但 descriptor 可控，作为第一个默认接受的形态。indirect / larger SG 留待 descriptor accounting 验证后再开启。

### fallback 条件

以下情况退回 Phase 5A owned buffer 路径（计数器 `cached.async_dirty_flush_bounce_fallbacks`）：

- dirty run 包含非完整页
- EOF 附近出现零长度或部分页
- page 带有 mmap listener（尚无完整的写保护协议）
- page 已经处于 writeback
- segment 数量超过块设备 descriptor budget
- LoongArch64 需要更保守的 descriptor 深度

## dirty 标记的清除时机

dirty flush 最容易出错的地方是**何时清除 dirty 标记**。

正确顺序：

```text
submit write
  -> wait completion
  -> device 报告 success
  -> re-check page 状态
  -> clear dirty / clear writeback
```

不能在 submit 时清 dirty。submit 只表示请求进入队列，不代表设备已写完。

部分成功时，只能清除已确认成功的范围，其余页必须保持 dirty。

失败时，page cache 中的数据仍是最新版本。dirty 状态保留意味着后续还有机会重试 flush。如果错误路径清除了 dirty，文件系统会误以为数据已落盘。

## counter

page cache 侧：

```text
cached.async_dirty_flush_hits           — flush consumer 触发次数
cached.async_dirty_flush_pages          — 参与 flush 的页数
cached.async_dirty_flush_bytes          — flush 字节数
cached.async_dirty_flush_sg_hits        — 走到 SG 零拷贝路径的次数
cached.async_dirty_flush_sg_segments    — SG segment 总数
cached.async_dirty_flush_bounce_fallbacks — fallback 到 owned buffer 的次数
cached.async_dirty_flush_errors         — flush 错误（必须为 0）
```

block queue 侧（与 ch3 相同的通用 counter）：

```text
virtio.blk_async_max_depth              — 实际队列深度峰值
virtio.blk_async_completion_errors      — 必须为 0
virtio.blk_async_resource_leaks         — 必须为 0
```

RV Phase 5B 实测：`sg_hits = 26`，`sg_segments = 1664`，`bounce_fallbacks = 25`，`writeback_restarts = 0`，所有 error counter = 0。

## 与后续 consumer 的关系

dirty run flush 作为第一个 consumer 验证了队列契约的完整闭环：

```text
buffer 必须活到 completion
状态只能在 completion 成功后发布
失败时必须保留可恢复状态
```

后续的 user direct I/O 和 lwext4 read path 复用同一套规则，不再各自发明私有异步路径。下一章介绍这两个更高风险的 consumer。
