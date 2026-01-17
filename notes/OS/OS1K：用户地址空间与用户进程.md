# OS1K：用户地址空间与用户进程

## 目录

1. [宏观概览](#1-宏观概览)
2. [构建流程](#2-构建流程)
3. [用户运行时环境](#3-用户运行时环境)
4. [内核至用户的转换](#4-内核至用户的转换)
5. [页表与虚拟内存](#5-页表与虚拟内存)
6. [SBI (监管者二进制接口)](#6-sbi-监管者二进制接口)
7. [核心概念](#7-核心概念)

---

## 1. 宏观概览

### 为何需要用户进程？

在此次变更之前，进程在**内核内部**运行，拥有完全的特权：

```c
// 旧版：内核态进程
void proc_a_entry(void) {
    printf("A");  // 直接调用内核函数
    yield();
}
proc_a = create_process((uint32_t)proc_a_entry);
```

变更之后，进程在**用户模式**下运行，权限受到限制：

```c
// 新版：用户态进程
create_process(_binary_shell_bin_start, (size_t)_binary_shell_bin_size);
```

### 用户进程的优势

| 特性                      | 优势                           |
| :------------------------ | :----------------------------- |
| **隔离性 (Isolation)**    | 每个进程拥有独立的地址空间     |
| **保护机制 (Protection)** | 用户无法访问内核内存           |
| **稳定性 (Stability)**    | 出错的用户程序无法导致内核崩溃 |

### RISC-V 特权级

```
┌─────────────────────────────────────────────┐
│           U-mode (用户模式)                  │  ← 用户程序 (shell.c)
│           权限最低                           │
├─────────────────────────────────────────────┤
│           S-mode (监管模式)                  │  ← 内核 (kernel.c)
│           可管理内存、处理异常                 │
├─────────────────────────────────────────────┤
│           M-mode (机器模式)                  │  ← OpenSBI 固件
│           权限最高 - 拥有完全控制权            |
└─────────────────────────────────────────────┘
```

---

## 2. 构建流程

### shell.bin 是如何构建并嵌入的

```
shell.c + user.c + common.c
       │
       ▼ (使用 user.ld 编译)
   shell.elf  (带元数据的 ELF 文件，链接地址为 0x1000000)
       │
       ▼ (objcopy -O binary)
   shell.bin  (仅包含原始字节)
       │
       ▼ (objcopy -Ibinary)
  shell.bin.o (包含 _binary_xxx 符号的目标文件)
       │
       ▼ (与内核链接)
   kernel.elf (内核 + 嵌入的 shell 二进制文件)
```

### 构建命令 (run.sh)

```bash
# 第1步：编译用户程序
$CC $CFLAGS -Wl,-Tuser.ld -o shell.elf shell.c user.c common.c

# 第2步：将 ELF 转换为原始二进制 (raw binary)
$OBJCOPY --set-section-flags .bss=alloc,contents -O binary shell.elf shell.bin

# 第3步：将二进制封装为目标文件 (生成 _binary_shell_bin_start 符号)
$OBJCOPY -Ibinary -Oelf32-littleriscv shell.bin shell.bin.o

# 第4步：将所有内容链接进内核
$CC $CFLAGS -Wl,-Tkernel.ld -o kernel.elf \
    kernel.c common.c sbi.c memory.c process.c trap.c shell.bin.o
```

### 用户链接脚本 (user.ld)

```ld
ENTRY(start)

SECTIONS {
    . = 0x1000000;              /* 用户程序起始于 16 MB 处 */

    .text :{
        KEEP(*(.text.start));   /* 入口点放在最前面 */
        *(.text .text.*);
    }

    .rodata : ALIGN(4) { *(.rodata .rodata.*); }
    .data : ALIGN(4) { *(.data .data.*); }

    .bss : ALIGN(4) {
        *(.bss .bss.* .sbss .sbss.*);
        . = ALIGN(16);
        . += 64 * 1024;         /* 64 KB 用户栈 */
        __stack_top = .;
        ASSERT(. < 0x1800000, "too large executable");
    }
}
```

### 内存布局

```
0x00000000 ┌─────────────────────┐
           │   (保留区域)         │
0x01000000 ├─────────────────────┤ ← USER_BASE (用户基址)
           │   用户程序           │   shell.bin 加载于此
           │   .text, .data      │
           │   stack (64 KB)     │
0x01800000 ├─────────────────────┤ ← 用户空间上限
           │   (未映射区域)        │
0x80200000 ├─────────────────────┤ ← __kernel_base (内核基址)
           │   内核               │
           │   .text, .data      │
           │   shell.bin (嵌入)   │   原始副本存于内核 .data 段
           │   .bss (procs[])    │
           │   kernel stack      │
0x80242000 ├─────────────────────┤ ← __free_ram (空闲内存)
           │   页表               │   动态分配
           │   用户页面副本        │
0x84242000 └─────────────────────┘ ← __free_ram_end
```

### 在 create_process() 之前 shell.bin 在哪里？

`shell.bin` 嵌入在内核的 `.data` 段中：

| 符号                      | 地址         | 描述                     |
| :------------------------ | :----------- | :----------------------- |
| `_binary_shell_bin_start` | `0x80200e1c` | 嵌入的二进制文件起始地址 |
| `_binary_shell_bin_end`   | `0x802113cc` | 嵌入的二进制文件结束地址 |

当 `create_process()` 运行时，它将 `shell.bin` **复制**到新分配的页面中，并将它们映射到 `0x1000000`。

---

## 3. 用户运行时环境

### user.c — 用户空间入口点

```c
extern char __stack_top[];

__attribute__((noreturn)) void exit(void) {
    for (;;);  // 待办：实现通往内核的系统调用 (syscall)
}

void putchar(char ch) { /* 待办：实现系统调用 */ }

__attribute__((section(".text.start")))
__attribute__((naked)) // 裸函数，不生成函数序言/结语
void start(void) {
    __asm__ __volatile__(
        "mv sp, %[stack_top] \n"  // 初始化栈指针
        "call main           \n"  // 调用用户的 main()
        "call exit           \n"  // 若 main 返回则清理
        :: [stack_top] "r"(__stack_top)
    );
}
```

### 执行流程

```
内核将 shell.bin 加载至 0x1000000
            │
            ▼
┌───────────────────────┐
│  start() @ 0x1000000  │ ← 第一条指令
│  ──────────────────── │
│  1. mv sp, __stack_top│   设置用户栈
│  2. call main         │   跳转至用户代码
└───────────┬───────────┘
            ▼
┌───────────────────────┐
│       main()          │ ← 你的程序
└───────────┬───────────┘
            │ (如果 main 返回)
            ▼
┌───────────────────────┐
│       exit()          │ ← 死循环 (待办：系统调用)
└───────────────────────┘
```

### 每个进程的两个栈

| 栈名称 | 位置                       | 大小  | 用途               |
| :----- | :------------------------- | :---- | :----------------- |
| 内核栈 | `proc->stack`              | 8 KB  | 陷阱处理、系统调用 |
| 用户栈 | 用户空间中的 `__stack_top` | 64 KB | 用户函数调用       |

---

## 4. 内核至用户的转换

### user_entry() 函数

```c
__attribute__((naked)) void user_entry(void) {
    __asm__ __volatile__(
        "csrw sepc, %[sepc]        \n"  // 跳转目标 (USER_BASE)
        "csrw sstatus, %[sstatus]  \n"  // 设置 U 模式，开启中断
        "sret                      \n"  // 返回用户模式！
        :
        : [sepc] "r"(USER_BASE),
          [sstatus] "r"(SSTATUS_SPIE)
    );
}
```

### 关键寄存器

| 寄存器         | 用途                      | 设定值                  |
| :------------- | :------------------------ | :---------------------- |
| `sepc`         | `sret` 之后的跳转地址     | `0x1000000` (USER_BASE) |
| `sstatus.SPP`  | 之前的特权级 (0=U, 1=S)   | `0` (返回 U 模式)       |
| `sstatus.SPIE` | `sret` 之后的中断使能状态 | `1` (开启)              |

### sret 指令

`sret` 原子地执行三件事：

1. 跳转到 `sepc` 中的地址 (0x1000000)
2. 切换到 U 模式 (因为 `SPP=0`)
3. 从 `SPIE` 恢复中断状态

### 完整转换流程

```
kernel_main()
     │
     ▼
create_process() ──► 在栈上设置 ra = user_entry
     │
     ▼
yield()
     │
     ▼
switch_context() ──► 恢复 ra, 执行 "ret"
     │
     ▼
user_entry() ◄────── 仍处于 S 模式
     │
     │  sepc = 0x1000000
     │  sstatus.SPP = 0
     │  sret
     ▼
start() @ 0x1000000  ← 现在处于 U 模式！
```

---

## 5. 页表与虚拟内存

### Sv32 两级页表

```
虚拟地址 (32 位):
┌──────────┬──────────┬──────────────┐
│  VPN[1]  │  VPN[0]  │ 页内偏移量     │
│  10 位   │  10 位   │    12 位      │
└──────────┴──────────┴──────────────┘

VPN[1] → 一级页表索引 (1024 项)
VPN[0] → 零级页表索引 (1024 项)
偏移量 → 4KB 页面内的字节位置 (0-4095)
```

### 页表项 (PTE) 格式

```
┌─────────────────────────────┬───────────────────┐
│     PPN (物理页号)          │       标志位         │
│       Bit 31-10             │      Bit 9-0      │
└─────────────────────────────┴───────────────────┘

标志位 (Flags):
  Bit 0: V (Valid, 有效)
  Bit 1: R (Readable, 可读)
  Bit 2: W (Writable, 可写)
  Bit 3: X (Executable, 可执行)
  Bit 4: U (User accessible, 用户可访问) ← 用户模式的关键！
```

### VPN 宏 (kernel.h)

```c
#define VPN1(vaddr) (((vaddr) >> 22) & 0x3ff)  // 一级索引
#define VPN0(vaddr) (((vaddr) >> 12) & 0x3ff)  // 零级索引
```

### map_page() 函数

```c
void map_page(uint32_t *table1, uint32_t vaddr, paddr_t paddr, uint32_t flags) {
    uint32_t vpn1 = VPN1(vaddr);

    // 如果需要，创建零级页表
    if ((table1[vpn1] & PAGE_V) == 0) {
        uint32_t pt_paddr = alloc_pages(1);
        table1[vpn1] = ((pt_paddr / PAGE_SIZE) << 10) | PAGE_V;
    }

    uint32_t vpn0 = VPN0(vaddr);
    uint32_t *table0 = (uint32_t *)(PTE_PPN(table1[vpn1]) * PAGE_SIZE);

    // 设置最终映射
    table0[vpn0] = ((paddr / PAGE_SIZE) << 10) | flags | PAGE_V;
}
```

### 每个进程拥有独立的页表

```c
struct process {
    int pid;
    int state;
    vaddr_t sp;
    uint32_t *page_table;  // ← 每个进程独有一份！
    uint8_t stack[8192];
};
```

### 页表切换 (yield)

```c
__asm__ __volatile__(
    "sfence.vma\n"                 // 刷新 TLB
    "csrw satp, %[satp]\n"         // 切换页表
    "sfence.vma\n"                 // 再次刷新 TLB
    :
    : [satp] "r"(SATP_SV32 | ((uint32_t)next->page_table / PAGE_SIZE))
);
```

### SATP 寄存器格式

```
┌──────────┬────────────────────────────────────┐
│   MODE   │        PPN (物理页号)                │
│  Bit 31  │           Bit 21-0                 │
└──────────┴────────────────────────────────────┘

MODE = 1 (SATP_SV32) → 启用 Sv32 分页
PPN = page_table_address / PAGE_SIZE
```

### 为何内核映射在每个进程中

```c
// 在 create_process() 中:
for (paddr_t paddr = (paddr_t)__kernel_base; paddr < (paddr_t)__free_ram_end;
     paddr += PAGE_SIZE)
    map_page(page_table, paddr, paddr, PAGE_R | PAGE_W | PAGE_X);  // 无 PAGE_U!
```

**恒等映射 (Identity mapping)**：内核的虚拟地址 = 物理地址。

这允许：

1. 页表切换后内核代码能继续运行
2. 内核可以从任何进程上下文中访问其数据结构
3. 陷入内核时无需切换页表

### 双进程示例

```
进程 A 的页表                   进程 B 的页表
──────────────────────          ──────────────────────
0x1000000 → A 的代码            0x1000000 → B 的代码     ← 不同
0x80200000 → 内核               0x80200000 → 内核        ← 相同 (恒等映射)

当 SATP 从 A 切换到 B 时:
- 用户空间 (0x1000000) 发生变化
- 内核空间 (0x80200000) 保持不变
```

---

## 6. SBI (监管者二进制接口)

### 什么是 SBI？

SBI 是你的内核 (S-mode) 与固件 (M-mode) 之间的接口。

```
用户 (U-mode)     ──ecall──►  内核 (S-mode)
内核 (S-mode)     ──ecall──►  OpenSBI (M-mode)
OpenSBI (M-mode)  ──direct──► 硬件
```

### sbi_call() 函数

```c
struct sbiret sbi_call(long arg0, long arg1, long arg2, long arg3,
                       long arg4, long arg5, long fid, long eid) {
    register long a0 __asm__("a0") = arg0;
    // ... 设置寄存器 a1-a7 ...
    register long a7 __asm__("a7") = eid;

    __asm__ __volatile__("ecall"  // 陷入 M 模式
                         : "=r"(a0), "=r"(a1)
                         : /* inputs */
                         : "memory");
    return (struct sbiret){.error = a0, .value = a1};
}

// 内核的 putchar 使用 SBI
void putchar(char ch) {
    sbi_call(ch, 0, 0, 0, 0, 0, 0, 1);  // eid=1 是控制台输出字符
}
```

### 两个 putchar 函数

| 文件             | 调用者            | 工作原理                           |
| :--------------- | :---------------- | :--------------------------------- |
| `sbi.c` (kernel) | 内核的 `printf()` | 通过 `ecall` 调用 OpenSBI          |
| `user.c` (user)  | 用户程序          | **待办**: 需要通过系统调用请求内核 |

---

## 7. 核心概念

### 物理内存 vs 虚拟内存

```
alloc_pages() 返回 物理 地址 (来自 __free_ram)
用户程序看到 虚拟 地址 (0x1000000+)
页表负责转换：虚拟 → 物理

同一个物理页面可以被映射到不同的虚拟地址！
```

### 恒等映射 (Identity Mapping)

```
对于内核：虚拟地址 == 物理地址
例如：虚拟 0x80200000 → 物理 0x80200000

为什么？为了让内核能够：
1. 使用物理地址作为指针
2. 在页表切换后继续运行
3. 轻松访问其数据结构
```

### PAGE_U 标志

```
带有 PAGE_U:    用户 可以 访问此页面
不带 PAGE_U:    用户 无法 访问 (触发页错误！)

内核页面:       无 PAGE_U → 用户无法触碰内核内存
用户页面:       有 PAGE_U → 用户可以访问自己的内存
```

### MMU 始终活跃

当启用分页 (设置 SATP) 后，**所有**内存访问都经过 MMU：

- 内核访问 → 经过转换 (但由于恒等映射，是透明的)
- 用户访问 → 经过转换 (0x1000000 → 映射的位置)

内核无法绕过 MMU！这就是为什么需要恒等映射。

### 未来工作 (待办)

| 特性                     | 描述                                 |
| :----------------------- | :----------------------------------- |
| 系统调用 (System calls)  | 用户发起 `ecall` → 内核陷阱处理程序  |
| 用户 `putchar()`         | 系统调用至内核，内核再调用 SBI       |
| 用户 `malloc()`/`mmap()` | 系统调用以分配页面，并映射至用户空间 |
| 多用户进程               | 加载不同程序，实现真正的多任务处理   |
| 进程终止                 | 清理页表，释放内存                   |

---

## 快速参考

### 重要地址

| 符号                 | 地址         | 描述             |
| :------------------- | :----------- | :--------------- |
| `__kernel_base`      | `0x80200000` | 内核起始地址     |
| `USER_BASE`          | `0x1000000`  | 用户程序起始地址 |
| `__free_ram`         | `0x80242000` | 动态分配池       |
| `__stack_top` (内核) | `0x80241c54` | 内核栈顶         |
| `__stack_top` (用户) | 用户空间内   | 用户栈顶         |

### 重要寄存器

| 寄存器     | 用途                                  |
| :--------- | :------------------------------------ |
| `satp`     | 页表基址 + 分页模式                   |
| `sepc`     | 异常程序计数器 (用于 `sret` 返回地址) |
| `sstatus`  | 状态标志 (SPP, SPIE 等)               |
| `stvec`    | 陷阱处理程序地址                      |
| `sscratch` | 暂存寄存器 (通常存内核栈指针)         |

### 重要标志位

| 标志           | 位   | 含义                         |
| :------------- | :--- | :--------------------------- |
| `PAGE_V`       | 0    | 有效项 (Valid)               |
| `PAGE_R`       | 1    | 可读 (Readable)              |
| `PAGE_W`       | 2    | 可写 (Writable)              |
| `PAGE_X`       | 3    | 可执行 (Executable)          |
| `PAGE_U`       | 4    | 用户可访问 (User accessible) |
| `SSTATUS_SPIE` | 5    | 之前的中断使能状态           |
| `SSTATUS_SPP`  | 8    | 之前的特权级 (0=U, 1=S)      |

---

## 总结图示

```
╔══════════════════════════════════════════════════════════════════╗
║                          完整全景图                                ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  构建阶段 (BUILD TIME):                                           ║
║  ──────────────────────                                          ║
║  shell.c → shell.elf → shell.bin → shell.bin.o → kernel.elf      ║
║                                                                  ║
║  启动阶段 (BOOT TIME):                                            ║
║  ─────────────────────                                           ║
║  QEMU 加载 kernel.elf (包含位于 0x80200e1c 的 shell.bin)           ║
║                                                                  ║
║  进程创建 (PROCESS CREATION):                                     ║
║  ────────────────────────────                                    ║
║  create_process():                                               ║
║    1. 从 __free_ram 分配页面                                       ║
║    2. 将 shell.bin 复制到新页面                                     ║
║    3. 创建页表:                                                    ║
║       - 映射内核 (恒等映射，无 PAGE_U)                               ║
║       - 在 0x1000000 映射用户 (有 PAGE_U)                           ║
║    4. 设置 ra = user_entry                                        ║
║                                                                  ║
║  上下文切换 (CONTEXT SWITCH):                                      ║
║  ────────────────────────────                                    ║
║  yield() → switch_context() → user_entry():                      ║
║    1. 设置 sepc = 0x1000000 (去往何处)                             ║
║    2. 设置 sstatus.SPP = 0 (返回 U 模式)                           ║
║    3. sret → 跳转至用户模式!                                       ║
║                                                                  ║
║  用户代码运行 (USER CODE RUNS):                                    ║
║  ──────────────────────────────                                  ║
║  start() @ 0x1000000 → main() → (你的程序!)                       ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
```