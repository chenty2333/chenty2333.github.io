# lwext4 read path

## 问题：映射可能失效

文件系统的 read path 需要将**文件偏移**翻译成**磁盘 block**。lwext4 通过 inode → extent tree → physical block 完成这个映射。

如果 read path 查到：

```text
logical block 0..3 -> physical block 1000..1003
```

这是一个 **mapped run**（逻辑地址连续、物理地址也连续的映射区间）。把它合并为一次大请求可以减少块设备交互次数。

但这个映射**不是永久有效的**。`truncate`、`unlink`、hole punch、重新分配 block 都可能改变映射。如果在 async read submit 之后、completion 之前，另一个路径 truncate 了文件，这段映射可能已经不再属于该文件。如果 completion 后仍将数据发布到 page cache，用户就会读到**过期数据（stale read）**。

## mapping cookie

为了防止 stale read，mapped read 使用 **mapping cookie**（映射序列号）机制：

```text
1. 查映射时记录当前 mapping sequence
2. submit async read
3. completion 返回
4. 发布结果前，re-check mapping sequence 是否仍然 current
5. cookie 失效 -> 丢弃结果 / fallback 重读
```

计数器 `ext4.async_mapped_read_cookie_rejects` 记录因 cookie 失效被拒绝的次数。

## page cache fill

buffered read 的 cache miss 路径通常是：先把文件页读入 page cache，标记 **uptodate**，再从 page cache copy 到用户 buffer。

async read 的安全做法：

```text
分配 private page
  -> submit async read
  -> completion success
  -> insert into page cache / mark uptodate
```

completion 之前不能把半成品 page 暴露给普通 read。只有数据完整到达后才能标记 uptodate。

## sparse hole

稀疏文件可能包含 **hole**（未分配物理 block 的逻辑区间）。hole 读出来应该是全零。

```text
logical block -> hole (physical = 0 / unmapped)
  -> memset zero（不进入 block device read）
```

async mapped read 只适用于已映射、对齐、连续、target buffer 生命周期明确的范围。hole 和 fragmented extent 走同步 fallback 或零填充。

## readahead

顺序读时，当前 page miss 往往意味着后续 page 也即将被读取。**readahead**（预读）在读当前页时顺便把后续页读入 page cache。

TheKernel 的 readahead 窗口为 64 页，默认关闭（`cached_readahead_on` / `off`），通过 counter 观测效果：

```text
cached.readahead_misses          = 248
cached.readahead_windows         = 32
cached.readahead_pages           = 2016
cached.readahead_hits            = 1953
cached.readahead_retired_unused  = 63
```

预读出来但始终未被使用的页面在缓存压力下优先退休。

## 实现边界

lwext4 async read 的第一版采取保守策略：

- 只处理 block-aligned range
- 只处理当前有效 mapped run（cookie 校验通过）
- 只在 target buffer/page 能持有到 completion 时启用
- 按 descriptor budget 和 mapped extent boundary 分 chunk
- 保留同步 mapped-read fallback
- LoongArch64 保守 depth

非对齐 head/tail、fragmented extent、hole、cookie 失效、segment 过多等情况全部 fallback。

## counter

```text
ext4.async_mapped_read_hits            — async read 触发
ext4.async_mapped_read_runs            — mapped run 合并次数
ext4.async_mapped_read_bytes           — async read 字节数
ext4.async_mapped_read_fallbacks       — fallback 到同步路径
ext4.async_mapped_read_cookie_rejects  — cookie 失效拒绝
```

RV Phase 8 实测：`hits = 1108`，`cookie_rejects = 0`，`fallbacks = 8`，`completion_errors = 0`，`resource_leaks = 0`。read path depth = 1（当前每次只提交一个 read，尚未 batch）。

## 两个 consumer 的共同点

| 维度 | user direct I/O | lwext4 read path |
|---|---|---|
| buffer 生命周期 | user pin guard 持有到 completion | page pin 或 owned buffer 持有到 completion |
| 不可取消 | submit 后不能因信号释放 buffer | submit 后不能因 truncate 释放 buffer |
| fallback | 退回 copy 路径，正确但慢 | 退回同步 mapped read，正确但慢 |
| 默认状态 | off（`user_direct_async_off`） | off（`lwext4_async_read_off`） |
| 正确性约束 | pin/unpin 平衡，zero leaks | cookie 有效，zero stale read |

两者都复用 ch4 建立的 owned request + descriptor admission + completion drain + hybrid wait 契约。不引入私有异步路径。

下一章是整轮工作的复盘：分数、陷阱、真正留下来的能力。
