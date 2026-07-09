# TheKernel I/O 性能优化手记

TheKernel 的 iozone 分数不理想。最初押注激进改造 lwext4 和 page cache，绝大多数尝试被否决。profiler 归因后：瓶颈在块设备层**队列深度 1**和**提交后的被动等待**，不在请求碎片化、文件系统或锁内工作量。后续围绕 **async/batch block** 展开，再接入 dirty flush、用户页直连、lwext4 读路径等 consumer。

### 目录

- [ch1：I/O 路径与 iozone](#/labs/thekernel-io-boost/ch1) — profiler 定位瓶颈
- [ch2：最初的计划](#/labs/thekernel-io-boost/ch2) — 激进 lwext4 蓝图
- [ch3：被否决的实验](#/labs/thekernel-io-boost/ch3) — 按方向分组的否决记录
- [ch4：async/batch block queue](#/labs/thekernel-io-boost/ch4) — 异步队列引擎
- [ch5：page cache dirty run flush](#/labs/thekernel-io-boost/ch5) — 第一个 consumer
- [ch6：pin/unpin 与 user direct I/O](#/labs/thekernel-io-boost/ch6) — 用户页 consumer
- [ch7：lwext4 read path](#/labs/thekernel-io-boost/ch7) — 文件系统读路径 consumer
- [ch8：复盘](#/labs/thekernel-io-boost/ch8) — 分数、陷阱、留下来的能力

### 结果说明

优化前（2026-06-30 评测），iozone 每个测试点得分 20.0；这轮工作后单测试点约 22（+10%）。

> **前提**
>
> 读者了解系统调用 → VFS → page cache → 文件系统 → 块设备的基本结构。页面 pin、VirtIO 队列、completion 契约等在涉及时说明。