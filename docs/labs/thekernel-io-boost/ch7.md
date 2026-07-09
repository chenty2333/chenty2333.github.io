# lwext4 read path

## 映射失效

read path 把文件偏移译成磁盘 block：inode → extent tree → physical block。

```text
logical block 0..3 -> physical block 1000..1003
```

这是 **mapped run**。合并成大请求可减少块设备交互。

映射会随 `truncate`、`unlink`、hole punch、重分配而变。async read submit 后、completion 前若另一路径 truncate 了文件，completion 后仍把数据放进 page cache 会得到 **stale read**。

## mapping cookie

mapped read 用 **mapping cookie**（映射 sequence）防 stale read：

```text
1. 查映射时记 mapping sequence
2. submit async read
3. completion
4. 发布前 re-check sequence 是否仍 current
5. cookie 失效 → 丢弃 / fallback 重读
```

`ext4.async_mapped_read_cookie_rejects` 记 cookie 失效拒绝次数。

## page cache fill

buffered read miss：读入 page cache、标 **uptodate**、再 copy 到用户 buffer。

async read：

```text
分配 private page
  -> submit async read
  -> completion success
  -> insert page cache / mark uptodate
```

completion 前不把半成品 page 暴露给普通 read。

## hole

稀疏文件有 **hole**（无物理 block 的逻辑区间），读出来全零。

```text
logical block -> hole
  -> memset zero（不进 block device read）
```

async mapped read 只用于已映射、对齐、连续、buffer 能活到 completion 的范围。hole、fragmented extent 走同步 fallback 或零填充。

## readahead

顺序读时 page miss 常意味后续页也将读取。**readahead** 在读当前页时预读后续页进 page cache。

窗口 64 页，默认关（`cached_readahead_on` / `off`）：

```text
cached.readahead_misses          = 248
cached.readahead_windows         = 32
cached.readahead_pages           = 2016
cached.readahead_hits            = 1953
cached.readahead_retired_unused  = 63
```

预读未用的页在缓存压力下优先淘汰。

## 实现边界

第一版保守：

- block-aligned range
- 当前有效 mapped run（cookie 通过）
- target buffer/page 活到 completion
- 按 descriptor budget 和 extent boundary 分 chunk
- 同步 mapped-read fallback
- LA 保守 depth

非对齐 head/tail、fragmented extent、hole、cookie 失效、segment 过多 → fallback。

## counter

```text
ext4.async_mapped_read_hits
ext4.async_mapped_read_runs
ext4.async_mapped_read_bytes
ext4.async_mapped_read_fallbacks
ext4.async_mapped_read_cookie_rejects
```

RV Phase 8：`hits = 1108`，`cookie_rejects = 0`，`fallbacks = 8`，`completion_errors = 0`，`resource_leaks = 0`。read path depth = 1，尚未 batch。

与 [ch6](#/labs/thekernel-io-boost/ch6) 相同契约：buffer 活到 completion；submit 后不可因信号或 truncate 提前释放；fallback 正确但慢；默认 off（`lwext4_async_read_off`）。