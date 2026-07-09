# 最初的计划

[ch1](#/labs/thekernel-io-boost/ch1) 的 profiler 还没把方向指到块设备层时，优化计划押在 **lwext4 和 page cache** 上。

当时的判断：iozone 慢，因为文件 I/O 热路径上有大量重复工作——每次读写重新查 inode、逐块查 extent、数据在 `VmBytes` 和内核缓冲之间多次搬运、readahead 先读进 scratch `Vec` 再逐页插入 page cache。计划从 Linux 借机制思想，只实现 TheKernel 用的小型等价物。

## 热路径

iozone 以 1KB **record** 驱动整条链路。1KB 粒度下每层固定成本摊不薄。计划针对下表中的重复工作，不对某条 benchmark 命令特化。

| 环节 | 当时现状 | 计划对策 |
|---|---|---|
| inode 查找 | 每次 `read_at` / `write_at` 重新解析 | 热 inode 缓存（16 项 LRU） |
| extent 映射 | 逐逻辑块查 extent 树 | extent status cache + 多块 `get_blocks` |
| 用户缓冲 I/O | `VmBytes` + 内核临时缓冲多次拷贝 | 用户页 pin + 同步/异步 direct I/O |
| page cache miss | scratch `Vec` 读满窗口再插入 | scratch 移除、对齐 bypass、cluster |
| dirty 写回 | 小窗口逐页 flush | 范围 writeback、脏页节流 |
| 块设备提交 | submit one, wait one | plug → blk-mq 式有界队列（Phase 6） |

**blk-mq 式块队列**排在 Phase 6。profiler 归因完成前，上层改造是主战场。

## 借鉴的 Linux 机制

**extent status tree**：内存里记录每段逻辑块状态（written / hole / unwritten / delayed），查磁盘 extent 树前先查它。计划在 `lwext4_rust` 做有界 per-inode 等价物，先支持 written 和 hole。

**mini-iomap**：映射查询与 page cache / direct I/O 分离，用 validity cookie 检测过期映射。计划加 `MappedRun` / `MapSeq`，truncate、hole punch、重分配时递增 sequence。

**multi-block allocation**：一次分配连续 run。计划暴露 `ext4_extent_get_blocks(..., max_blocks, create=true)`，顺序整块写一次分配物理块。

**pin_user_pages**：短期 DIO pin 与长期 DMA pin 分开。先做短期同步 pin，pin/unpin 成熟后再做异步 DIO。

**blk-mq**：软件队列、请求合并、tag、硬件派发。计划先做 plug，再演进成有界块队列。

## 八个阶段

| 阶段 | 内容 | 依赖 |
|---|---|---|
| Phase 0 | 基线、计数器、验收门槛 | — |
| Phase 1 | 热 inode 缓存、extent 状态缓存、extent 预取、多块映射/分配 | Phase 0 |
| Phase 2 | mini-iomap、overwrite-only 快路径、对齐 bypass、scratch 移除 | Phase 1 |
| Phase 3 | page cache cluster、范围 writeback、脏页节流、sync 延迟 | Phase 2 |
| Phase 4 | 用户页 slice、批量缺页、pin/unpin、同步用户缓冲直连 I/O | Phase 3 |
| Phase 5 | 基于 pin 页的异步 DIO、completion 队列、取消/退出清理 | Phase 4 |
| Phase 6 | VirtIO plugging、有界多请求在飞、blk-mq 式调度 | Phase 5 |
| Phase 7 | delalloc-lite、extent 锁拆分、高并发扩展 | Phase 6 |

Phase 5 依赖 Phase 4 的 pin/unpin。Phase 7 的 delalloc-lite 标为高风险，需独立正确性阶段。Phase 6 的 blk-mq 式队列后来成为主线，但在最初计划里排第六。

## Phase 0 验收

Phase 0 不加功能，只建测量与回滚：

- **基准分数**（cap1024 no-stats）：44.099（RV，musl 22.465 + glibc 21.634）
- **对比**：同一份 support image、同一版 `src/init.sh`、**no-stats**
- **判定**：总分相对基准的百分比；musl / glibc 分项是否显著退化

> **no-stats**
>
> 运行时不开 `/proc/io_stats` 诊断计数器。开启后忙等轮询会多一次原子递增，干扰吞吐。性能判定必须在 no-stats 下做。

`/proc/io_stats` 控制字 `on` / `off` / `reset`，默认关。后续改动要求 counter 可观测、kill switch 可回滚。

## 约束

- 不为 benchmark 名、组标记、进程名、路径名特化
- 保留 `fsync`、`fdatasync`、`O_SYNC`、truncate、unlink、rename、mmap 语义
- 窄改动 + 回滚开关，优于大重写
- benchmark 数值只当趋势，不当评测预测
- 激进设计太危险时，落地安全子集，否决项连同失败模式一起记录

## 第一个检查点落地了什么

### 热 inode 缓存

`lwext4_rust::hot.rs`：16 项 LRU。`read_at` / `write_at` 走 `with_cached_inode_ref`；`flush` / drop 和元数据操作前 drain；`set_len` / `set_symlink` 时 invalidate。

### 多块 extent 映射

`ext4_extent_get_blocks`：`create=false` 多块读映射，`create=true` 整块写分配，单块 helper 作 fallback。

### 对齐 page cache bypass

`axfs-ng::CachedFile`：页对齐、非内存文件、64 KiB chunk；范围脏页 flush + 前后 invalidate。smoke：

```text
cached.read_bypass_hits > 0
cached.read_bypass_slice_hits > 0
cached.write_bypass_hits > 0
cached.write_bypass_slice_hits > 0
```

### I/O 计数器

`/proc/io_stats`：`on` / `off` / `reset`。评测热路径默认关。

## 写了但没 default-on 的条目

| 条目 | 状态 | 证据 |
|---|---|---|
| extent status cache | 实现，**default-off** | sentry 开启后 musl re-read 18249 → 4390 KB/s |
| mini-iomap | 未实现 | — |
| scratch 拷贝移除 | 未实现（[ch3](#/labs/thekernel-io-boost/ch3) 有实验） | — |
| page cache cluster | 未实现 | — |
| 用户页 pin/unpin、异步 DIO | 未接入 iozone 热路径 | 无 pin/lifetime guard 的 user slice 被拒绝 |
| VirtIO plugging、blk-mq 队列 | 留 Phase 6（后成 [ch4](#/labs/thekernel-io-boost/ch4)） | — |
| delalloc、extent 锁拆分 | 留 Phase 7 | — |

extent status cache 是唯一写了代码却不敢 default-on 的 Phase 1 项。其余大项未动工，或在 profiler 归因后让位给块设备层工作。具体否决过程见 [ch3](#/labs/thekernel-io-boost/ch3)。