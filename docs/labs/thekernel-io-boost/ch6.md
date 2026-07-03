# 复盘

本章整理这轮 I/O 优化的最终状态：分数怎么读、踩过哪些陷阱、LoongArch64 与 RISC-V 的差异、以及真正留下来的系统能力。

## 分数

### focused iozone

| 指标 | 值 |
|---|---|
| best closed baseline（RV no-stats） | 44.251（glibc 21.854 + musl 22.397） |
| post-10B（RV no-stats） | 44.001（glibc 21.964 + musl 22.037） |
| 差异 | -0.565% |

post-10B 分数低于 best closed baseline 约 0.5%，在运行间波动范围内。曾出现过单次 45.41 的高值（+2.62%），但后续 live-regen 只有 44.42（+0.38%），说明 run-to-run variance 真实存在。

**结论**：满足 no-material-regression 条件，但**不主张 iozone 有稳定提升**。

### full replay

| 架构 | total_score | markers | complete_groups | issues |
|---|---|---|---|---|
| RV | 1368.92 | 42 | 21 | 0 |
| LA | 1392.81 | 42 | 21 | 0 |

两个架构均通过 validator 的完整性检查。LA 总分略高于 RV（LA iozone 绝对吞吐更高），但 LA 使用保守 async 配置。

### 分数不能混看

focused iozone 只看文件 I/O 热路径。full replay 包含 LTP、lmbench 等更多内容。full replay 中的提升可能来自：

- 性能路径改善
- 时间预算变化（前面的组更快，后面的组获得更多时间）
- 稳定性提升（fewer timeout）
- `src/init.sh` 清理逻辑的修复

需要区分来源，不能把 full replay 的变化全部归因于 iozone 优化。

## 踩过的陷阱

### support image 骗分

评测脚本依赖 support image（根磁盘镜像），其中包含 `/meta/init.sh`、测试计划、环境变量等。

一次 Phase 6 的 iozone 跑出了 45.239 的高分。事后检查发现：support image 中的 `/meta/init.sh` SHA-256 与当前工作区的 `src/init.sh` **不一致**。该分数使用了旧版脚本，不能作为当前代码的有效证据。

**修复**：每次 replay 前执行 `scripts/oscomp.sh support-check`，校验 image 内嵌的 `init.sh` hash 与工作区一致。该检查已接入 `make check-eval-artifacts`。

> **规则**
>
> 性能对比必须满足：kernel 是新构建的、support image 是新生成的、image 中 `/meta/init.sh` 与 `src/init.sh` 一致、无残留 `oscomp.env` 干扰默认 auto 路径。否则结果无效。

### lmbench 组间残留

full replay 中出现过 `/musl lmbench` → `/glibc lmbench` 切换时 timeout 的问题。

最小复现：

```text
单独跑 /glibc lmbench → 通过
先跑 /musl lmbench，再跑 /glibc lmbench → timeout
```

定位到组间残留：`/var/tmp/XXX`、`/tmp/XXX` 和 lmbench helper 进程影响了后续组。该问题与 async block queue **无关**——在显式 `OSCOMP_ASYNC_BLOCK=off` 下同样复现。

**修复**：`src/init.sh` 中加入组间清理：

```text
rm -rf /var/tmp/XXX /tmp/XXX
kill lmbench helper leftovers
```

### WaitQueue 不能在所有上下文中使用

Phase 4 实现 hybrid wait 时，第一次尝试直接调用 `WaitQueue::wait_timeout_until`：

```text
panic: assertion failed: curr.can_preempt(2)
  at axtask/src/run_queue.rs
  triggered by: cat /proc/io_stats（async selftest 后）
```

原因：VFS / exec / page-cache 路径中仍持有额外的 **preemption guard**（例如 lwext4 的 `SpinNoPreempt` 锁），在这种上下文中进入调度器会违反 preemption 计数约束。

**修复**：引入 `axtask::can_block_current()`。wait path 先检查，能 block 才 sleep，否则走 bounded yield/spin 并记录 fallback。

### compile-time async default-on 导致启动挂死

一次实验尝试在 `virtio-drivers` 中静态开启 async：

```text
RV replay：只有 OpenSBI 输出，无 kernel console，idle timeout 600s 后终止
```

原因：early boot 阶段调度器尚未初始化，async wait 路径尝试进入调度器导致挂死。

**修复**：compile-time async 默认关闭。运行时通过 `src/init.sh` 在 `/proc/io_stats` 存在之后才 opt-in：

```text
RV auto: OSCOMP_ASYNC_BLOCK=on, OSCOMP_ASYNC_DIRTY_FLUSH_SG=on, async_block_depth=4
非 RV auto: async_block_off
```

### LoongArch64 IRQ handler table 不够大

LA 的 irq_first 注册失败，因为 platform IRQ handler table 大小为 13，而 QEMU virt PCI INTx 线从 16 开始（PCH-PIC/EIOINTC external vectors）。IRQ 16 超出表范围。

**修复**：扩大 `axplat-loongarch64-qemu-virt/src/irq.rs` 中的 handler table，覆盖 EIOINTC external vectors。

## LoongArch64 与 RISC-V 的差异

| 维度 | RISC-V | LoongArch64 |
|---|---|---|
| 角色定位 | 性能目标 | 正确性目标 |
| 默认 async depth | 4 | 1 |
| SG dirty flush | 默认开启 | 显式开启 |
| indirect descriptor | 可用 | 不假设 |
| event-idx | 可用 | 不假设 |
| max_depth 实测 | 4 | 2 |

Phase 9 对 LA 进行了 depth gate 实验：depth-1 vs depth-2+SG 全量 21 组 replay 对比。

```text
depth-1:    submit_requests=481,  iozone musl=100s, glibc=147s, total=4724s
depth-2+SG: submit_requests=13016, iozone musl=101s, glibc=147s, total=4730s
```

正确性通过（markers=42, complete_groups=21, issues=0, zero errors），深度确实提高了（max_depth=2, sg_hits=581），但**性能没有改善**。

决策记录为 `keep-la-conservative`：LA 保持 depth=1 + SG off 作为默认，直到有正面性能证据。

## 真正留下来的能力

这轮工作的核心产出不在某一个 iozone 数字上，而是一组**可以继续扩展的系统能力**：

- **block queue 拥有请求对象**：不再依赖调用者栈上的临时变量
- **descriptor-aware admission**：按描述符预算控制提交，区分架构差异
- **统一 completion drain**：submit / wait / queue-full / interrupt 四条入口共享
- **hybrid wait + irq_first**：不再无界忙轮询，可区分 spin / yield / sleep / wakeup
- **dirty flush consumer**：支持 owned buffer（5A）和 page-cache SG 零拷贝（5B）
- **user direct I/O consumer**：pin/unpin guard 持有到 completion
- **lwext4 read consumer**：mapping cookie 防 stale read，async mapped run
- **每个 consumer 独立回滚开关 + counter**：出问题时可逐个关闭定位

这些能力后续可以继续叠加：更大的 SG merge、indirect descriptor accounting、更多真实 consumer 进入 blocking-safe IRQ-first 路径、adaptive depth。

每一层新优化接入时，遵循同一组规则：

```text
buffer 必须活到 completion
状态只能在 completion 成功后发布
失败时必须保留可恢复状态
默认关闭，counter 先行，证据决定是否 default-on
```
