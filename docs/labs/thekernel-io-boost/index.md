# TheKernel I/O 性能优化手记

这组文章记录 TheKernel 文件 I/O 路径的一轮优化过程。

TheKernel 的 iozone 分数不理想。最初的计划押注在激进改造 lwext4 和 page cache 上，绝大多数尝试被否决。profiler 逐层归因后发现：瓶颈不在请求碎片化、不在文件系统、不在锁里的工作量，而在块设备层的**队列深度只有 1** 加上**请求提交后的被动等待**。后续工作围绕这个瓶颈展开：构建异步批量块设备队列，再逐步接入 dirty flush、用户页直连、lwext4 读路径等 consumer。

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

优化前（2026-06-30 评测），iozone 每个测试点得分为 20.0。经过这轮工作后，单测试点提升到 ~22，提升约 10%。

文章中的结论尽量落回具体路径和具体数据。分数、counter 值如实记录；没有证据支撑的判断会标明。

> **阅读前提**
>
> 默认读者了解文件 I/O 经过系统调用、VFS、page cache、文件系统、块设备这几层的基本结构。内核内部概念（页面 pin、VirtIO 队列、completion 契约等）会在涉及时解释。
