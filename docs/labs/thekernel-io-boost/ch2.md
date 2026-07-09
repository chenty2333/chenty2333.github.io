# 最初的计划

在 [ch1](#/labs/thekernel-io-boost/ch1) 的 profiler 把方向指向块设备层之前，最初的优化计划押注在另一个方向上：**激进改造 lwext4 和 page cache**。

当时的判断是：iozone 慢，主要因为 TheKernel 的文件 I/O 热路径上存在大量可省掉的重复工作——每次读写都重新查 inode、逐块查 extent 映射、数据在 `VmBytes` 用户拷贝包装和内核缓冲之间多次搬运、readahead 先读进 scratch `Vec` 再逐页拷入 page cache。计划的核心策略是从 Linux 成熟的机制里借设计思想，但只实现 TheKernel 专属的小型等价物。

## 热路径上的具体问题

iozone 以 1KB **record** 驱动整条文件 I/O 链路。路径上每一层都有固定成本；1KB 粒度下，这些成本无法被摊薄。计划针对的是下表中的重复工作，而不是某一条 benchmark 命令本身。

| 环节 | 现状（计划制定时） | 计划中的对策 |
|---|---|---|
| inode 查找 | 每次 `read_at` / `write_at` 重新解析 inode | 热 inode 缓存（16 项 LRU） |
| extent 映射 | 逐逻辑块查 extent 树 | extent status cache + 多块 `get_blocks` |
| 用户缓冲 I/O | `VmBytes` 包装 + 内核临时缓冲多次拷贝 | 用户页 pin + 同步/异步 direct I/O |
| page cache miss | scratch `Vec` 读满窗口再逐页插入 | scratch 移除、对齐 bypass、cluster |
| dirty 写回 | 小窗口逐页 flush | 范围 writeback、脏页节流 |
| 块设备提交 | submit one, wait one | plug → blk-mq 式有界队列（Phase 6） |

计划把 **blk-mq 式块队列**排在 Phase 6。profiler 归因完成之前，上层文件系统与 page cache 改造是主战场。

## 借鉴的 Linux 机制

**extent status tree**：Linux ext4 在内存里维护一棵 extent 状态树，记录每段逻辑块的状态（written / hole / unwritten / delayed），查磁盘 extent 树之前先查它，内存压力下回收条目。计划要在 `lwext4_rust` 里实现一个有界的 per-inode Rust 等价物，先支持 written 和 hole 两种状态。

**mini-iomap**：Linux iomap 把映射查询和 page cache / direct I/O 机制分离，并用一个 validity cookie 检测过期映射。计划要加 `MappedRun` / `MapSeq` 抽象，让 page cache 和 direct 路径能安全消费同一批映射 run，任何使映射失效的操作（truncate、hole punch、重分配）都递增 sequence。

**multi-block allocation**：Linux ext4 的多块分配器一次分配连续 run，减少碎片。计划要在 Rust 侧暴露 `ext4_extent_get_blocks(..., max_blocks, create=true)` 接口，为顺序整块写一次性分配连续物理块。

**pin_user_pages**：Linux 区分短期 DIO pin 和长期 DMA pin。计划要让用户页 I/O 先做短期同步 pin，只有在 pin/unpin 基础设施成熟后才允许异步 DIO 让用户页活过系统调用返回。

**blk-mq**：Linux blk-mq 用软件队列、请求合并、tag、硬件派发队列实现多队列块层。计划要先加一个小的 plug（攒批）作用域，再演进成带请求 tag / 合并 / barrier / completion 队列的有界块队列。

## 八个阶段

| 阶段 | 内容 | 依赖 |
|---|---|---|
| Phase 0 | 基线、计数器、验收门槛 | — |
| Phase 1 | lwext4 热 inode 缓存、extent 状态缓存、extent 预取、多块映射/分配 | Phase 0 |
| Phase 2 | mini-iomap 映射 I/O、overwrite-only 快路径、对齐 page cache bypass、scratch 拷贝移除 | Phase 1 |
| Phase 3 | page cache cluster（大 folio 等价物）、范围 writeback、脏页节流、sync 延迟 | Phase 2 |
| Phase 4 | 用户页 slice、批量缺页、显式 pin/unpin、同步用户缓冲直连 I/O | Phase 3 |
| Phase 5 | 基于 pin 页的异步 direct I/O、completion 队列、取消/退出清理 | Phase 4 |
| Phase 6 | VirtIO 请求 plugging、有界多请求在飞、blk-mq 式调度 | Phase 5 |
| Phase 7 | delalloc-lite、extent 级锁拆分、高并发扩展 | Phase 6 |

Phase 5 依赖 Phase 4 的 pin/unpin 成熟。Phase 7 的 delalloc-lite 被标为高风险，需要独立正确性阶段。Phase 6 的 blk-mq 式块队列后来成为真正落地的方向——但在最初计划里排在第六位，远非第一优先级。

## Phase 0 验收门槛

Phase 0 不给功能，只建立测量与回滚能力：

- **基准分数**（cap1024 no-stats baseline）：44.099（RV，musl 22.465 + glibc 21.634）
- **对比方式**：同一份 support image、同一版 `src/init.sh`、**no-stats** 模式
- **判定标准**：总分相对基准的百分比变化；musl / glibc 分项是否出现显著退化

> **no-stats 模式**
>
> 指运行时不开启 `/proc/io_stats` 的 VirtIO 诊断计数器。开启诊断时每次忙等轮询都会执行额外的原子递增，会干扰吞吐测量。性能判定必须在 no-stats 下完成。

计数器通过 `/proc/io_stats` 暴露，默认关闭（`on` / `off` / `reset`）。任何后续 Phase 的改动都必须在 counter 可观测、kill switch 可回滚的前提下推进。

## 约束

计划给自己定了一组硬约束：

- 不为 benchmark 名字、组标记、进程名、路径名做特化
- 保留全部文件语义：`fsync`、`fdatasync`、`O_SYNC`、truncate、unlink、rename、mmap 可见性
- 窄改动 + 回滚开关，优于大重写
- 当前 benchmark 数值只当趋势证据，不当最终评测预测
- 如果激进设计太危险，落地安全部分，把被否决的设计连同失败模式一起记录

## 实际落地的子集

截至第一个实现检查点，真正留下来的只有一个安全子集：

### 热 inode 缓存

`lwext4_rust::hot.rs`：固定 16 项 LRU。`read_at` / `write_at` 走 `with_cached_inode_ref`；`flush` / drop 和元数据操作前 drain；`set_len` / `set_symlink` 时 invalidate。

### 多块 extent 映射

`ext4_extent_get_blocks` 包装：`create=false` 用于多块读映射，`create=true` 用于整块写分配，保留单块 helper 作 fallback。

### 对齐 page cache bypass

`axfs-ng::CachedFile`：页对齐、非内存文件、64 KiB chunk。遵循 direct I/O 的缓存一致性——范围脏页 flush + 前后 invalidate。smoke 计数器确认路径生效：

```text
cached.read_bypass_hits > 0
cached.read_bypass_slice_hits > 0
cached.write_bypass_hits > 0
cached.write_bypass_slice_hits > 0
```

### disabled-by-default I/O 计数器

`/proc/io_stats` 控制字：`on` / `off` / `reset`。评测热路径默认不开启。

## 未完成与 default-off 的条目

| 条目 | 状态 | 证据 |
|---|---|---|
| extent status cache | 已实现，**default-off** | RV sentry 开启后 musl re-read 从 18249 掉到 4390 KB/s |
| mini-iomap | 未实现 | — |
| page cache scratch 拷贝移除 | 未实现（后由 ch3 实验部分覆盖） | — |
| page cache cluster | 未实现 | — |
| 用户页 pin/unpin、异步 DIO | 第一版未接入 iozone 热路径 | 返回用户 slice 无 pin/lifetime guard 被明确拒绝 |
| VirtIO plugging、blk-mq 式队列 | 留待 Phase 6（后成为 ch4 主线） | — |
| delalloc、extent 锁拆分 | 留待 Phase 7 | — |

extent status cache 是唯一「写了代码但不敢 default-on」的 Phase 1 条目。其余大项要么未动工，要么在 profiler 归因后被更高优先级的块设备层工作取代。

## 与后续章节的关系

这份蓝图里绝大多数条目最终没有按原计划顺序落地。时间线上，三件事交叉进行：

1. **Phase 0–2 的安全子集**按本计划推进（热 inode、bypass、计数器）
2. **profiler 归因**（ch1）逐步把主战场从 page cache / ext4 挪到块设备层
3. **上层实验**（ch3）在归因前后大量尝试 readahead、锁收窄、缓存策略等方向，绝大多数被回滚

Phase 6 的 blk-mq 式队列在计划里排在后面，在归因完成后反而成为主线（[ch4](#/labs/thekernel-io-boost/ch4)）。ch3 记录被否决的实验；ch4 起记录真正落地的 async block queue 及 consumer。