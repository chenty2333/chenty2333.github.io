# 被否决的实验

[ch1](#/labs/thekernel-io-boost/ch1) 定位块设备层前后，page cache、文件系统、readahead、锁粒度等方向做了大量实验，绝大多数回滚。下面按方向记改法、测量和回滚原因。

## 测量口径

- **基准**（cap1024 no-stats）：44.099（RV，musl 22.465 + glibc 21.634）
- **对比**：同 support image、同 `src/init.sh`、no-stats
- **判定**：总分相对基准的百分比；musl / glibc 分项是否显著退化

> **no-stats**
>
> 不开 `/proc/io_stats` 诊断计数器。开启后忙等轮询多一次原子递增，干扰吞吐。

---

## readahead

两个改动保留：**backward suppression**、**可复用 scratch buffer**。其余七次回滚。

### backward suppression（保留）

`ensure_page_cached_with()` 加方向判断：当前 miss 页号低于上次 miss 时只读 1 页，否则保持 64 页前向窗口。

```text
glibc/iozone-read-backwards page_cache_fill_read: 604.841 -> 282.272 ms
musl/iozone-read-backwards page_cache_fill_read:  441.760 -> 269.933 ms
```

反向扫描 fill-read 减半。反向访问时预读 N+1..N+63 用不上（fill/block ratio 6.1 → 接近 1）。

### reusable scratch buffer（保留）

cache miss 时持锁执行 `let mut buf = vec![0u8; ra * PAGE_SIZE];`。改为 `CachedFileShared` 上 `Mutex<Vec<u8>>` 复用，仅容量增长时重分配。

```text
glibc/iozone-random-read page_cache_fill_alloc: 1215.446 -> 3.722 ms
glibc/iozone-random-read page_cache_lock_hold:  2061.827 -> 722.448 ms
```

`fill_alloc` 从上千 ms 到个位数，`lock_hold` 降 30–76%。

### sequential readahead gate

`readahead_last_miss` 旁加 `readahead_last_pages`：仅当 miss == 上次 miss + 上次窗口时给 64 页，否则 1 页。

变体 1（所有 cold miss 给 1 页）：

```text
glibc/iozone-auto page_cache_fill_read: 199.260 -> 287.696 ms
musl/iozone-auto page_cache_fill_read:  211.780 -> 271.141 ms
```

变体 2（page-0 cold miss 给完整窗口）：

```text
glibc/iozone-read-backwards page_cache_flush: 40.526 -> 283.718 ms
musl/iozone-write-read page_cache_flush:      39.874 -> 248.790 ms
```

last-miss 预测器太粗。random-read 的 lock_hold 收窄了，成本转到 sequential auto 和 flush-heavy 阶段。回滚。

### per-stream forward-random gate

predictor 从 inode 全局（`CachedFileShared`）移到 per-stream（`CachedFile`），miss 远离上次 miss+window 时只读 1 页。

```text
glibc/iozone-auto page_cache_fill_read: 199.260 -> 288.889 ms
musl/iozone-read-backwards fill_read:   171.940 -> 556.876 ms
musl/iozone-write-read lock_hold:       836.765 -> 1117.889 ms
```

前向门槛削弱了 sequential-sensitive 阶段预读，musl 退化严重。回滚。

### per-stream backward predictor ownership

策略不变，只把 `readahead_last_miss` 从 inode 全局移到 per-stream。

```text
glibc/iozone-read-backwards fill_read:  186.561 -> 424.722 ms
musl/iozone-read-backwards fill_read:   171.940 -> 479.581 ms
glibc/iozone-read-backwards lock_hold: 1124.446 -> 1568.322 ms
```

仅移所有权就大幅退化。inode 全局 predictor history 对跨 open 的 read-backward/write-read 是 load-bearing 的。回滚。

### persistent readahead history（FileUserData）

`readahead_last_miss` 改为 `Arc<AtomicU32>` 存入 `FileUserData`，page cache 释放后仍保留 history。

```text
reopen-backward elapsed: ~1.50s -> 0.33–0.35s
musl/io-pattern-reopen-backward fill_read: 443.767 -> 44.251 ms
```

fill_read 大幅改善，但 `bb sync` 挂死，QEMU 超时。读侧 hint 耦合到 file-cache registry（sync 遍历/prune）。回滚。

### readahead history sidecar

history 移到独立 `BTreeMap<(device, inode), last_miss_page>`，与 file registry 解耦。

```text
glibc/iozone-read-backwards fill_read（stressed）: 282.272 -> 424.569 ms
```

hang 修好了，iozone phase 矩阵复现 per-stream ownership 的 glibc/read-backwards 退化。predictor ownership 与 lock-held outer-window 尾延迟耦合，暂不能安全改。回滚。

### in-flight miss coalescing / 单页 fill

同页并发 miss 合并等待（`CachedFileShared::clean_read_inflight`），fill 从 64 页缩到单页。

```text
page_cache_inflight_wait count = 0（所有 iozone phase 行）
glibc/iozone-auto fill_read: 199.260 -> 480.457 ms
glibc/iozone-auto block_read: 153.821 -> 404.682 ms
```

评测 smp=1 串行，无同页并发 miss，`inflight_wait` 始终 0。砍掉 sequential readahead 后 fill_read、block_read 翻倍退化。回滚。

---

## lock

[ch1](#/labs/thekernel-io-boost/ch1) 显示 `lock_hold` 1400+ ms，fill_insert / read_copy / flush_prepare 合计才几百 ms。试过两次收窄锁，都回滚。

### miss-read outside lock

clean miss：锁内 plan，放锁读 scratch，重拿锁插入（期间若无他任务填充同页）。

```text
glibc/iozone fill_read: 1076.889 -> 908.760 ms
musl/iozone fill_read:   785.802 -> 1216.356 ms
glibc/iozone flush:      538.355 -> 957.201 ms
```

glibc 改善、musl 退化，flush 恶化。smoke 过，full-iozone 矩阵不稳。120ms fill-read 停顿是 runnable-but-off-CPU，收窄锁碰不到调度。回滚。

### flush outside lock

per-PageCache atomic id + per-page dirty generation；锁内快照脏页批次，放锁 `file.write_at`，重拿锁且 id+generation 匹配才清 dirty。另处理 append/write 互斥、`set_len`、`direct_io_lock.write()`、内部 drain helper 防自死锁。

```text
musl/iozone-read-backwards lock_hold:  867.459 -> 1411.920 ms
musl/iozone-read-backwards fill_read:  171.940 ->  304.091 ms
musl/iozone-read-backwards flush:       62.225 ->  224.752 ms
```

review 发现 public `drain/invalidate` 和 `set_len()` 有 stale-snapshot 竞态，full-iozone 中途 abort（Error 130）。放锁后页可被替换或重标脏，补丁越打锁越多，lock_hold 反升。回滚。

---

## 环境约束

### in-flight miss coalescing（single-HART）

readahead 节已述。评测 **single-HART serial**（smp=1）：同一时刻只有一个任务做 page cache fill，无同页并发 miss。`page_cache_inflight_wait` 全程 0。

同样约束 per-inode 锁收窄：单核串行时 inode 间读并发不存在。

---

## 其它

### 1KB pending 聚合

page cache 单页 pending 缓冲：4-bit 1KiB 掩码，四 chunk 凑齐一次提交，跳过旧页读。

```text
RV musl:  161917 -> 138857  (-14.24%)
RV glibc: 167426 -> 149805  (-10.52%)
```

`cached.write_pending_rewrite_chunks` = 60276，总分仍大幅退化。跳过的旧页读不是瓶颈；per-1KiB 拷贝和 pending 锁维护成本更高。请求流已 ~135KiB/个，1KiB 粒度省一次读无意义。回滚。

### lazy partial-rewrite valid-prefix

每页维护 valid-prefix，前缀写或超 EOF 写跳过旧页读，缺字节延迟补齐。

| 架构/libc | 变化 |
|---|---|
| RV musl | -1.0% |
| RV glibc | +4.8% |
| LA musl | +0.2% |
| LA glibc | -5.2% |

簿记和 lazy materialize 在 1KiB workload 下成本高，LA 尤其明显，跨架构不一致。回滚。

### CRC32c unroll-by-8

`ext4_crc32.c` `crc32()` unroll-by-8。

总分 44.112（+0.03%），musl -2.19%，glibc +2.34%。噪声范围内。ISA `rv64imafdch` 无 Zbc/Zbkc，carry-less-multiply 会非法指令。回滚。

### 降低 FILE_IO_COOPERATE_INTERVAL

`axtask::yield_now()` 间隔 4096 → 16384。

总分 44.129（+0.07%），musl -2.54%。yield 频率已够低。回滚。

### scheduler-yield 注入 VirtIO 等待循环

忙等循环每 256 次轮询 `yield_now()`。

QEMU 超时，无 kernel prompt。块设备等待循环上下文可能持锁或 preemption guard，直接 yield 死锁。须在更高层分离 submit 和 wait（[ch4](#/labs/thekernel-io-boost/ch4)）。回滚。

### sub-4KiB user pin 阈值

user-pin 最低阈值 4KiB → 1KiB。

```text
总分: 44.099 -> 43.002 (-2.49%)
musl: -5.66%
```

1KiB record 下 pin probe 固定成本重复上千次，超过省下 copy。4KiB 阈值让 iozone 完全不进 pin（`user_pin.to_user_attempts = 0`）。回滚。

### retained closed-file cache 4096 页

关闭文件后保留页上限 1024 → 4096。

总分 43.861（-0.54%）。读行改善被 score cap 截断，写行退化。回滚。

### naive 4KiB chunk batch submit

连续 `read_block` / `write_block` buffer 拆成 4KiB chunk，一次 publish 多个到 virtqueue。

smoke：`blk_pending_max_depth = 4`。no-stats replay 卡死 `iozone automatic measurements`。

切碎连续大请求有了深度，但破坏了 iozone 路径形态。应让 dirty flush、readahead 等上层请求同时进队列（[ch4](#/labs/thekernel-io-boost/ch4)）。回滚。

### per-inode 锁收窄 / 无锁 mapped read

axfs-ng 64 路 inode 分片锁；lwext4 `DirectReadPlan` 锁内快照 extents 后放锁读。

总分 44.015（-0.19%）。extent-planning + device mutex 无吞吐收益。smp=1 下 inode 间读并发不存在，限制在 block 完成和队列深度。回滚。

### fill-insert zero-tail

miss 插入：先 copy `file.read_at` 字节，再只清零尾部，代替整页先清零再 copy。

```text
glibc/iozone-write-read fill_insert: 244.136 -> 16.261 ms
musl/iozone-write-read lock_hold:    492.141 -> 1161.713 ms
musl/iozone-read-backwards lock_hold: 869.161 -> 1485.646 ms
```

部分行 fill_insert 改善，musl lock_hold 和 fill-read 整体退化。须先做 zero-fill context attribution 再试。回滚。

### flush window 512

`MAX_DIRTY_WRITEBACK_PAGES` 256 → 512。

```text
glibc/iozone page_cache_flush:   538.355 -> 769.867 ms
musl/iozone page_cache_fill_read: 785.802 -> 1072.018 ms
```

flush 事件 73→63，总等待反升，musl fill-read 退化。保持 256。

> **flush 256（保留）**
>
> `MAX_DIRTY_WRITEBACK_PAGES` 64→256：flush count 277→73，`block_write` 53ms→38ms。512 是过度推进。

---

块请求已合并到 ~168/135 KiB，1KB 粒度继续合并或省读无收益。队列深度锁在 1，上层优化绕不开 submit one, wait one。120ms fill-read 来自 off-CPU，两次锁收窄碰不到调度。smp=1 下依赖并发的优化无效。

backward suppression 和 reusable scratch buffer 针对无用预读和重复分配；它们不解决 depth=1——那是 [ch4](#/labs/thekernel-io-boost/ch4)。