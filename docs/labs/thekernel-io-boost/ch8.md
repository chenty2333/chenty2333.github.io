# 复盘

## 分数

### focused iozone

| 指标 | 值 |
|---|---|
| best closed baseline（RV no-stats） | 44.251（glibc 21.854 + musl 22.397） |
| post-10B（RV no-stats） | 44.001（glibc 21.964 + musl 22.037） |
| 差异 | -0.565% |

post-10B 低于 best closed baseline 约 0.5%，在运行间波动内。曾单次 45.41（+2.62%），后续 live-regen 44.42（+0.38%），run-to-run variance 存在。

满足 no-material-regression，但 iozone 没有稳定提升的证据。

### full replay

| 架构 | total_score | markers | complete_groups | issues |
|---|---|---|---|---|
| RV | 1368.92 | 42 | 21 | 0 |
| LA | 1392.81 | 42 | 21 | 0 |

validator 完整性检查通过。LA 总分略高（iozone 绝对吞吐更高），用保守 async 配置。

### focused 与 full replay

focused iozone 只看文件 I/O 热路径。full replay 含 LTP、lmbench 等。full replay 变化可能来自性能改善、时间预算重分配、timeout 减少、`src/init.sh` 清理修复——不能全归因于 iozone 优化。

## 陷阱

### support image 骗分

评测依赖 support image（`/meta/init.sh`、测试计划、环境变量）。

一次 iozone 跑出 45.239。事后查 image 内 `/meta/init.sh` SHA-256 与工作区 `src/init.sh` **不一致**，分数无效。

修复：replay 前 `scripts/oscomp.sh support-check`，已接入 `make check-eval-artifacts`。

> **有效对比**
>
> 新构建 kernel、新生成 support image、`/meta/init.sh` 与 `src/init.sh` 一致、无残留 `oscomp.env`。否则无效。

### lmbench 组间残留

`/musl lmbench` 后跑 `/glibc lmbench` 曾 timeout。单独跑 glibc 通过。

残留：`/var/tmp/XXX`、`/tmp/XXX`、lmbench helper 进程。`OSCOMP_ASYNC_BLOCK=off` 下同样复现，与 async queue 无关。

`src/init.sh` 组间清理：`rm -rf /var/tmp/XXX /tmp/XXX`，kill lmbench helper。

### WaitQueue 上下文

Phase 4 首次直接调 `WaitQueue::wait_timeout_until`：

```text
panic: assertion failed: curr.can_preempt(2)
  at axtask/src/run_queue.rs
```

VFS / exec / page-cache 路径持 **preemption guard**（如 lwext4 `SpinNoPreempt`），此上下文不能进调度器。

引入 `axtask::can_block_current()`：能 block 才 sleep，否则 bounded yield/spin。

### compile-time async default-on

`virtio-drivers` 静态开 async：RV replay 只有 OpenSBI，kernel console 无输出，600s idle timeout。

early boot 调度器未初始化，async wait 进调度器挂死。

compile-time 默认关；`src/init.sh` 在 `/proc/io_stats` 存在后 opt-in：

```text
RV auto: OSCOMP_ASYNC_BLOCK=on, OSCOMP_ASYNC_DIRTY_FLUSH_SG=on, async_block_depth=4
非 RV auto: async_block_off
```

### LA IRQ handler table

LA irq_first 注册失败：handler table 大小 13，QEMU virt PCI INTx 从 16 起，IRQ 16 越界。

扩大 `axplat-loongarch64-qemu-virt/src/irq.rs` handler table，覆盖 EIOINTC external vectors。

## RV 与 LA

| 维度 | RISC-V | LoongArch64 |
|---|---|---|
| 角色 | 性能目标 | 正确性目标 |
| 默认 async depth | 4 | 1 |
| SG dirty flush | 默认开 | 显式开 |
| indirect descriptor | 可用 | 不假设 |
| event-idx | 可用 | 不假设 |
| max_depth 实测 | 4 | 2 |

Phase 9 LA depth gate：depth-1 vs depth-2+SG，全量 21 组 replay。

```text
depth-1:    submit_requests=481,  iozone musl=100s, glibc=147s, total=4724s
depth-2+SG: submit_requests=13016, iozone musl=101s, glibc=147s, total=4730s
```

markers=42，complete_groups=21，issues=0，zero errors；max_depth=2，sg_hits=581，iozone 时间几乎不变。

`keep-la-conservative`：LA 默认 depth=1、SG off，直到有正面性能证据。

## 留下来的能力

- owned block request（队列持有到 completion）
- descriptor-aware admission（按架构调深度）
- opportunistic completion drain（submit / wait / queue-full / interrupt）
- hybrid wait + irq_first
- dirty flush consumer（5A owned buffer、5B page-cache SG）
- user direct I/O consumer（pin guard 到 completion）
- lwext4 read consumer（mapping cookie、async mapped run）
- 每 consumer 独立回滚开关 + counter

后续可叠：更大 SG merge、indirect descriptor accounting、更多 consumer 走 IRQ-first、adaptive depth。

新 consumer 接入时同一组规则：

```text
buffer 活到 completion
状态只在 completion 成功后发布
失败保留可恢复状态
默认关，counter 先行，证据决定 default-on
```