# OS1K: User Address Space and User Processes

## Table of Contents

1. [The Big Picture](#1-the-big-picture)
2. [Build Pipeline](#2-build-pipeline)
3. [User Runtime](#3-user-runtime)
4. [Kernel-to-User Transition](#4-kernel-to-user-transition)
5. [Page Tables and Virtual Memory](#5-page-tables-and-virtual-memory)
6. [SBI (Supervisor Binary Interface)](#6-sbi-supervisor-binary-interface)
7. [Key Concepts](#7-key-concepts)

---

## 1. The Big Picture

### Why User Processes?

Before this change, processes ran **inside the kernel** with full privileges:

```c
// OLD: Kernel-mode processes
void proc_a_entry(void) {
    printf("A");  // Direct kernel function call
    yield();
}
proc_a = create_process((uint32_t)proc_a_entry);
```

After this change, processes run in **user mode** with restricted privileges:

```c
// NEW: User-mode processes
create_process(_binary_shell_bin_start, (size_t)_binary_shell_bin_size);
```

### Benefits of User Processes

| Feature | Benefit |
|---------|---------|
| **Isolation** | Each process has its own address space |
| **Protection** | User can't access kernel memory |
| **Stability** | Buggy user program can't crash the kernel |

### RISC-V Privilege Levels

```
┌─────────────────────────────────────────────┐
│           U-mode (User Mode)                │  ← User programs (shell.c)
│           Least privileged                  │
├─────────────────────────────────────────────┤
│           S-mode (Supervisor Mode)          │  ← Kernel (kernel.c)
│           Can manage memory, traps          │
├─────────────────────────────────────────────┤
│           M-mode (Machine Mode)             │  ← OpenSBI firmware
│           Most privileged - full control    │
└─────────────────────────────────────────────┘
```

---

## 2. Build Pipeline

### How shell.bin is Built and Embedded

```
shell.c + user.c + common.c
       │
       ▼ (compile with user.ld)
   shell.elf  (ELF with metadata, linked at 0x1000000)
       │
       ▼ (objcopy -O binary)
   shell.bin  (raw bytes only)
       │
       ▼ (objcopy -Ibinary)
  shell.bin.o (object file with _binary_xxx symbols)
       │
       ▼ (link with kernel)
   kernel.elf (kernel + embedded shell binary)
```

### Build Commands (run.sh)

```bash
# Step 1: Compile user program
$CC $CFLAGS -Wl,-Tuser.ld -o shell.elf shell.c user.c common.c

# Step 2: Convert ELF to raw binary
$OBJCOPY --set-section-flags .bss=alloc,contents -O binary shell.elf shell.bin

# Step 3: Wrap binary as object file (creates _binary_shell_bin_start symbol)
$OBJCOPY -Ibinary -Oelf32-littleriscv shell.bin shell.bin.o

# Step 4: Link everything into kernel
$CC $CFLAGS -Wl,-Tkernel.ld -o kernel.elf \
    kernel.c common.c sbi.c memory.c process.c trap.c shell.bin.o
```

### User Linker Script (user.ld)

```ld
ENTRY(start)

SECTIONS {
    . = 0x1000000;              /* User programs start at 16 MB */

    .text :{
        KEEP(*(.text.start));   /* Entry point first */
        *(.text .text.*);
    }

    .rodata : ALIGN(4) { *(.rodata .rodata.*); }
    .data : ALIGN(4) { *(.data .data.*); }

    .bss : ALIGN(4) {
        *(.bss .bss.* .sbss .sbss.*);
        . = ALIGN(16);
        . += 64 * 1024;         /* 64 KB user stack */
        __stack_top = .;
        ASSERT(. < 0x1800000, "too large executable");
    }
}
```

### Memory Layout

```
0x00000000 ┌─────────────────────┐
           │   (reserved)        │
0x01000000 ├─────────────────────┤ ← USER_BASE
           │   User Program      │   shell.bin loaded here
           │   .text, .data      │
           │   stack (64 KB)     │
0x01800000 ├─────────────────────┤ ← Max user space
           │   (unmapped)        │
0x80200000 ├─────────────────────┤ ← __kernel_base
           │   Kernel            │
           │   .text, .data      │
           │   shell.bin (embed) │   Original copy in kernel .data
           │   .bss (procs[])    │
           │   kernel stack      │
0x80242000 ├─────────────────────┤ ← __free_ram
           │   Page tables       │   Allocated dynamically
           │   User page copies  │
0x84242000 └─────────────────────┘ ← __free_ram_end
```

### Where is shell.bin Before create_process()?

The shell.bin is embedded in the kernel's `.data` section:

| Symbol | Address | Description |
|--------|---------|-------------|
| `_binary_shell_bin_start` | `0x80200e1c` | Start of embedded binary |
| `_binary_shell_bin_end` | `0x802113cc` | End of embedded binary |

When `create_process()` runs, it **copies** shell.bin to newly allocated pages and maps them to `0x1000000`.

---

## 3. User Runtime

### user.c — User Space Entry Point

```c
extern char __stack_top[];

__attribute__((noreturn)) void exit(void) {
    for (;;);  // TODO: syscall to kernel
}

void putchar(char ch) { /* TODO: syscall to kernel */ }

__attribute__((section(".text.start")))
__attribute__((naked))
void start(void) {
    __asm__ __volatile__(
        "mv sp, %[stack_top] \n"  // Initialize stack pointer
        "call main           \n"  // Call user's main()
        "call exit           \n"  // Cleanup if main returns
        :: [stack_top] "r"(__stack_top)
    );
}
```

### Execution Flow

```
Kernel loads shell.bin at 0x1000000
            │
            ▼
┌───────────────────────┐
│  start() @ 0x1000000  │ ← First instruction
│  ──────────────────── │
│  1. mv sp, __stack_top│   Set up user stack
│  2. call main         │   Jump to user code
└───────────┬───────────┘
            ▼
┌───────────────────────┐
│       main()          │ ← Your program
└───────────┬───────────┘
            │ (if main returns)
            ▼
┌───────────────────────┐
│       exit()          │ ← Infinite loop (TODO: syscall)
└───────────────────────┘
```

### Two Stacks Per Process

| Stack | Location | Size | Purpose |
|-------|----------|------|---------|
| Kernel stack | `proc->stack` | 8 KB | Trap handling, syscalls |
| User stack | `__stack_top` in user space | 64 KB | User function calls |

---

## 4. Kernel-to-User Transition

### The user_entry() Function

```c
__attribute__((naked)) void user_entry(void) {
    __asm__ __volatile__(
        "csrw sepc, %[sepc]        \n"  // Where to jump (USER_BASE)
        "csrw sstatus, %[sstatus]  \n"  // Set U-mode, enable interrupts
        "sret                      \n"  // Return to user mode!
        :
        : [sepc] "r"(USER_BASE),
          [sstatus] "r"(SSTATUS_SPIE)
    );
}
```

### Key Registers

| Register | Purpose | Value Set |
|----------|---------|-----------|
| `sepc` | Where to jump after `sret` | `0x1000000` (USER_BASE) |
| `sstatus.SPP` | Previous privilege (0=U, 1=S) | `0` (return to U-mode) |
| `sstatus.SPIE` | Enable interrupts after `sret` | `1` (enabled) |

### The sret Instruction

`sret` does three things atomically:
1. Jump to address in `sepc` (0x1000000)
2. Switch to U-mode (because `SPP=0`)
3. Restore interrupt state from `SPIE`

### Complete Transition Flow

```
kernel_main()
     │
     ▼
create_process() ──► Sets ra = user_entry on stack
     │
     ▼
yield()
     │
     ▼
switch_context() ──► Restores ra, executes "ret"
     │
     ▼
user_entry() ◄────── Still in S-mode
     │
     │  sepc = 0x1000000
     │  sstatus.SPP = 0
     │  sret
     ▼
start() @ 0x1000000  ← Now in U-mode!
```

---

## 5. Page Tables and Virtual Memory

### Sv32 Two-Level Page Table

```
Virtual Address (32 bits):
┌──────────┬──────────┬──────────────┐
│  VPN[1]  │  VPN[0]  │ Page Offset  │
│ 10 bits  │ 10 bits  │   12 bits    │
└──────────┴──────────┴──────────────┘

VPN[1] → Index into Level-1 table (1024 entries)
VPN[0] → Index into Level-0 table (1024 entries)
Offset → Byte within 4KB page (0-4095)
```

### Page Table Entry (PTE) Format

```
┌─────────────────────────────┬───────────────────┐
│   PPN (Physical Page Number)│      Flags        │
│         Bits 31-10          │     Bits 9-0      │
└─────────────────────────────┴───────────────────┘

Flags:
  Bit 0: V (Valid)
  Bit 1: R (Readable)
  Bit 2: W (Writable)
  Bit 3: X (Executable)
  Bit 4: U (User accessible) ← KEY for user mode!
```

### VPN Macros (kernel.h)

```c
#define VPN1(vaddr) (((vaddr) >> 22) & 0x3ff)  // Level-1 index
#define VPN0(vaddr) (((vaddr) >> 12) & 0x3ff)  // Level-0 index
```

### map_page() Function

```c
void map_page(uint32_t *table1, uint32_t vaddr, paddr_t paddr, uint32_t flags) {
    uint32_t vpn1 = VPN1(vaddr);

    // Create Level-0 table if needed
    if ((table1[vpn1] & PAGE_V) == 0) {
        uint32_t pt_paddr = alloc_pages(1);
        table1[vpn1] = ((pt_paddr / PAGE_SIZE) << 10) | PAGE_V;
    }

    uint32_t vpn0 = VPN0(vaddr);
    uint32_t *table0 = (uint32_t *)(PTE_PPN(table1[vpn1]) * PAGE_SIZE);

    // Set the final mapping
    table0[vpn0] = ((paddr / PAGE_SIZE) << 10) | flags | PAGE_V;
}
```

### Each Process Has Its Own Page Table

```c
struct process {
    int pid;
    int state;
    vaddr_t sp;
    uint32_t *page_table;  // ← Each process has its own!
    uint8_t stack[8192];
};
```

### Page Table Switching (yield)

```c
__asm__ __volatile__(
    "sfence.vma\n"                 // Flush TLB
    "csrw satp, %[satp]\n"         // Switch page table
    "sfence.vma\n"                 // Flush TLB again
    :
    : [satp] "r"(SATP_SV32 | ((uint32_t)next->page_table / PAGE_SIZE))
);
```

### SATP Register Format

```
┌──────────┬────────────────────────────────────┐
│   MODE   │    PPN (Physical Page Number)      │
│  Bit 31  │         Bits 21-0                  │
└──────────┴────────────────────────────────────┘

MODE = 1 (SATP_SV32) → Enable Sv32 paging
PPN = page_table_address / PAGE_SIZE
```

### Why Kernel Is Mapped in Every Process

```c
// In create_process():
for (paddr_t paddr = (paddr_t)__kernel_base; paddr < (paddr_t)__free_ram_end;
     paddr += PAGE_SIZE)
    map_page(page_table, paddr, paddr, PAGE_R | PAGE_W | PAGE_X);  // No PAGE_U!
```

**Identity mapping**: Virtual address = Physical address for kernel.

This allows:
1. Kernel code continues running after page table switch
2. Kernel can access its data structures from any process context
3. No page table switch needed when trapping to kernel

### Two Processes Example

```
Process A's Page Table          Process B's Page Table
──────────────────────          ──────────────────────
0x1000000 → A's code            0x1000000 → B's code     ← DIFFERENT
0x80200000 → kernel             0x80200000 → kernel      ← SAME (identity mapped)

When SATP switches from A to B:
- User space (0x1000000) changes
- Kernel space (0x80200000) stays the same
```

---

## 6. SBI (Supervisor Binary Interface)

### What is SBI?

SBI is the interface between your kernel (S-mode) and the firmware (M-mode).

```
User (U-mode)     ──ecall──►  Kernel (S-mode)
Kernel (S-mode)   ──ecall──►  OpenSBI (M-mode)
OpenSBI (M-mode)  ──direct──► Hardware
```

### sbi_call() Function

```c
struct sbiret sbi_call(long arg0, long arg1, long arg2, long arg3,
                       long arg4, long arg5, long fid, long eid) {
    register long a0 __asm__("a0") = arg0;
    // ... set up registers a1-a7 ...
    register long a7 __asm__("a7") = eid;

    __asm__ __volatile__("ecall"  // Trap to M-mode
                         : "=r"(a0), "=r"(a1)
                         : /* inputs */
                         : "memory");
    return (struct sbiret){.error = a0, .value = a1};
}

// Kernel's putchar uses SBI
void putchar(char ch) {
    sbi_call(ch, 0, 0, 0, 0, 0, 0, 1);  // eid=1 is Console Putchar
}
```

### Two putchar Functions

| File | Who calls it | How it works |
|------|--------------|--------------|
| `sbi.c` (kernel) | Kernel's `printf()` | Calls OpenSBI via `ecall` |
| `user.c` (user) | User programs | **TODO**: needs syscall to kernel |

---

## 7. Key Concepts

### Physical vs Virtual Memory

```
alloc_pages() returns PHYSICAL addresses (from __free_ram)
User programs see VIRTUAL addresses (0x1000000+)
Page tables translate: Virtual → Physical

The SAME physical page can be mapped at DIFFERENT virtual addresses!
```

### Identity Mapping

```
For kernel: Virtual address == Physical address
Example: Virtual 0x80200000 → Physical 0x80200000

Why? So kernel can:
1. Use same pointers as physical addresses
2. Continue running after page table switch
3. Access its data structures easily
```

### PAGE_U Flag

```
With PAGE_U:    User CAN access this page
Without PAGE_U: User CANNOT access (page fault!)

Kernel pages:   No PAGE_U → User can't touch kernel memory
User pages:     Has PAGE_U → User can access their own memory
```

### MMU Always Active

When paging is enabled (SATP set), ALL memory accesses go through MMU:
- Kernel accesses → translated (but identity mapped, so transparent)
- User accesses → translated (0x1000000 → wherever mapped)

Kernel cannot bypass MMU! That's why identity mapping is needed.

### Future Work (TODO)

| Feature | Description |
|---------|-------------|
| System calls | `ecall` from user → kernel trap handler |
| User `putchar()` | Syscall to kernel, kernel calls SBI |
| User `malloc()`/`mmap()` | Syscall to allocate pages, map to user space |
| Multiple user processes | Load different programs, true multitasking |
| Process termination | Clean up page tables, free memory |

---

## Quick Reference

### Important Addresses

| Symbol | Address | Description |
|--------|---------|-------------|
| `__kernel_base` | `0x80200000` | Kernel start |
| `USER_BASE` | `0x1000000` | User program start |
| `__free_ram` | `0x80242000` | Dynamic allocation pool |
| `__stack_top` (kernel) | `0x80241c54` | Kernel stack top |
| `__stack_top` (user) | In user space | User stack top |

### Important Registers

| Register | Purpose |
|----------|---------|
| `satp` | Page table base + paging mode |
| `sepc` | Exception PC (return address for `sret`) |
| `sstatus` | Status flags (SPP, SPIE, etc.) |
| `stvec` | Trap handler address |
| `sscratch` | Scratch register (kernel stack pointer) |

### Important Flags

| Flag | Bit | Meaning |
|------|-----|---------|
| `PAGE_V` | 0 | Valid entry |
| `PAGE_R` | 1 | Readable |
| `PAGE_W` | 2 | Writable |
| `PAGE_X` | 3 | Executable |
| `PAGE_U` | 4 | User accessible |
| `SSTATUS_SPIE` | 5 | Previous interrupt enable |
| `SSTATUS_SPP` | 8 | Previous privilege (0=U, 1=S) |

---

## Summary Diagram

```
╔══════════════════════════════════════════════════════════════════╗
║                    THE COMPLETE PICTURE                          ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  BUILD TIME:                                                     ║
║  ───────────                                                     ║
║  shell.c → shell.elf → shell.bin → shell.bin.o → kernel.elf      ║
║                                                                  ║
║  BOOT TIME:                                                      ║
║  ──────────                                                      ║
║  QEMU loads kernel.elf (includes shell.bin at 0x80200e1c)        ║
║                                                                  ║
║  PROCESS CREATION:                                               ║
║  ─────────────────                                               ║
║  create_process():                                               ║
║    1. Allocate pages from __free_ram                             ║
║    2. Copy shell.bin to new pages                                ║
║    3. Create page table:                                         ║
║       - Map kernel (identity, no PAGE_U)                         ║
║       - Map user at 0x1000000 (with PAGE_U)                      ║
║    4. Set ra = user_entry                                        ║
║                                                                  ║
║  CONTEXT SWITCH:                                                 ║
║  ───────────────                                                 ║
║  yield() → switch_context() → user_entry():                      ║
║    1. Set sepc = 0x1000000 (where to go)                         ║
║    2. Set sstatus.SPP = 0 (return to U-mode)                     ║
║    3. sret → JUMP TO USER MODE!                                  ║
║                                                                  ║
║  USER CODE RUNS:                                                 ║
║  ───────────────                                                 ║
║  start() @ 0x1000000 → main() → (your program!)                  ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
```

