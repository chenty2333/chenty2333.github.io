# page cache dirty run flush

第一个接入 async/batch block queue 的 consumer 选 dirty run flush：dirty page 由内核管，生命周期比用户页简单，路径仍经过文件系统和块设备，能检验队列契约。

## dirty page 从哪来

`write(fd, buf, len)` 数据通常不立刻落盘。内核写入 **page cache** 对应页，标 **dirty**，再返回用户态。

```text
write(fd, buf, len)
  -> CachedFile::write_at
  -> 找到或创建 page cache page
  -> copy 用户数据到 cache page
  -> page.dirty = true
  -> 返回用户态
```

`fsync`、关闭、缓存压力、显式 flush 时才写回。iozone 的 write / rewrite / random write / pwrite / pwritev 不断制造 dirty page；1KB record 下写入次数多，同一批页反复写脏。后半段是 dirty page 怎么刷回去。

## 逐页 flush

逐页写回：

```text
dirty page 0 -> write_at(offset=0, 4096)    -> block submit -> wait
dirty page 1 -> write_at(offset=4096, 4096)  -> block submit -> wait
...
```

语义对，性能差。偏移连续的页在磁盘上往往也连续，逐页 flush 拆成多个 4KB 请求，每个都走映射、提交、completion。

**dirty run flush**：识别连续 dirty page 组成的 **run**，按 run 提交。

```text
dirty page 0..3 (连续)
  -> 合并 write_at(offset=0, 16384)
  -> block batch submit
```

## Phase 5A：owned buffer

第一版先把 dirty run **拷贝到内核 writeback buffer**，不直接把 page cache page 交给块设备。

```text
拿 page-cache lock
  -> 扫描连续 dirty page
  -> 拷贝到 owned writeback buffer（16-page / 64KiB segments）
  -> 记录 page number / offset / len
释放 page-cache lock
  -> file.write_at_vectored(...)   [async batch queue]
  -> wait all completions
重新检查 page 状态
  -> completion 成功 -> 清 dirty
  -> completion 失败 -> 保留 dirty
```

仍有一次 copy，但解决两件事：块设备 I/O 等待期间不能持 page-cache map lock（否则读写、回收、truncate 全堵）；owned buffer 由 flush 路径持有，completion 前不会被回收或并发写改。

> **Phase 5A**
>
> 暂时保留 copy，先验证：连续 dirty page 能成 run；run 能进 vectored write；async queue 能接；dirty 只在 completion 成功后清；失败保留 dirty。这层不稳时做零拷贝只会更难查。

```text
cached.async_dirty_flush_hits = 51
async_dirty_flush_pages = 1689
async_dirty_flush_bytes ≈ 6.86 MB
virtio.blk_async_max_depth = 4
```

## Phase 5B：page-cache SG

Phase 5B 去掉 copy，page cache page 直接作块设备 data segment。**SG**（scatter-gather）用多个 segment 描述物理上不连续的文件页。

```text
扫描连续 dirty page（>= 2 页、完整页、无 evict listener、未 writeback）
  -> pin pages
  -> mark writeback
  -> 构建 SG segments
  -> async vectored write
  -> completion
  -> clear dirty / clear writeback / unpin
```

### writeback 状态

page 在 writeback 时，并发 write 覆盖后 flush 清 dirty 会丢数据：

| 时间 | 事件 | 结果 |
|---|---|---|
| t1 | flush 提交内容 A | 设备写 A |
| t2 | 并发 write 改成 B | 内存是 B |
| t3 | completion 成功 | dirty 清除 |
| t4 | — | 内存 B，磁盘 A，dirty=false → B 丢失 |

writeback 中的 page 要标出来；并发 write 等 writeback 结束或 writeback 后重新标 dirty。

### SG4

最初整个 dirty run 映射成一个 SG 请求。RV QEMU 出现 queue-full、admission stall、`cached.async_dirty_flush_errors`。

接受 **SG4**：每个 async request 最多 4 个 data segment。请求数 320（每页一个）→ 160（SG2）→ **80**（SG4）。

> **indirect descriptor**
>
> indirect 可让一个请求带任意多 segment 且只占 1 个 virtqueue descriptor。LA 上 DMA 行为和 descriptor accounting 未充分验证。SG4 descriptor 可控，作为默认形态。

### fallback

退回 Phase 5A（`cached.async_dirty_flush_bounce_fallbacks`）：

- 非完整页、EOF 附近零长或部分页
- page 带 mmap listener
- page 已在 writeback
- segment 超 descriptor budget
- LA 需更保守 descriptor 深度

## dirty 标记何时清除

```text
submit write
  -> wait completion
  -> device success
  -> re-check page 状态
  -> clear dirty / clear writeback
```

submit 时不能清 dirty。部分成功只清已确认范围。失败保留 dirty——错误路径清了 dirty，文件系统会以为已落盘。

## counter

```text
cached.async_dirty_flush_hits
cached.async_dirty_flush_pages
cached.async_dirty_flush_bytes
cached.async_dirty_flush_sg_hits
cached.async_dirty_flush_sg_segments
cached.async_dirty_flush_bounce_fallbacks
cached.async_dirty_flush_errors         — 须为 0

virtio.blk_async_max_depth
virtio.blk_async_completion_errors      — 须为 0
virtio.blk_async_resource_leaks         — 须为 0
```

RV Phase 5B：`sg_hits = 26`，`sg_segments = 1664`，`bounce_fallbacks = 25`，`writeback_restarts = 0`，error counter 均为 0。