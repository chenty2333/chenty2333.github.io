# TheKernel I/O 性能优化手记

这组文章记录 TheKernel 文件 I/O 路径的一轮优化过程。

TheKernel 的 iozone 分数不理想。经过 profiler 定位，瓶颈不在请求合并（块请求已经足够大），而在块设备层的**队列深度只有 1** 加上**同步忙轮询**。后续工作围绕这个瓶颈展开：构建异步批量块设备队列，再逐步接入 dirty flush、用户页直连、lwext4 读路径等 consumer。

中间被回滚的实验比留下的多。这些失败同样有记录价值，因此也写在里面。

## 章节

- [ch1：I/O 路径与 iozone](#/labs/thekernel-io-boost/ch1) — 用 profiler 定位瓶颈
- [ch2：被否决的上层优化实验](#/labs/thekernel-io-boost/ch2)
- [ch3：async/batch block queue](#/labs/thekernel-io-boost/ch3) — 异步队列引擎
- [ch4：page cache dirty run flush](#/labs/thekernel-io-boost/ch4) — 第一个 consumer
- [ch5：用户页直连与 lwext4 读路径](#/labs/thekernel-io-boost/ch5) — 更高收益、更高风险的 consumer
- [ch6：复盘](#/labs/thekernel-io-boost/ch6) — 分数、踩坑、留下来的能力

## 结果说明

这轮优化**没有**产生 iozone 分数的显著提升。focused iozone 在改动后无明显退化，个别配置下有小幅提升，但在运行间波动范围内。真正留下来的是一套块设备层的异步能力——可以继续扩展的系统基础设施，而非针对单一 benchmark 的捷径。

文章中的结论尽量落回具体路径和具体数据。分数、counter 值如实记录；没有证据支撑的判断会标明。

> **阅读前提**
>
> 默认读者了解文件 I/O 经过系统调用、VFS、page cache、文件系统、块设备这几层的基本结构。内核内部概念（页面 pin、VirtIO 队列、completion 契约等）会在涉及时解释。
