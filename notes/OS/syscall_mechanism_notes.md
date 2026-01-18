# Syscall Mechanism Notes

This document summarizes the syscall implementation in os1k, based on commit `ce3ba6a` ("Implemented the syscall mechanism").

---

## Overview

A **system call (syscall)** is the mechanism by which user-space programs request services from the kernel. The flow is:

1. **User program** wants to do something (print a character, read input, exit)
2. User program triggers a **trap** using the `ecall` instruction
3. CPU switches to **kernel mode** and runs the trap handler
4. Kernel figures out what the user wants and does it
5. Kernel returns control to the user program

---

## Part 1: User-side Syscall Mechanism

### 1.1 Syscall Numbers (`syscall.h`)

```c
#define SYS_PUTCHAR 1
#define SYS_GETCHAR 2
#define SYS_EXIT 3
```

Defines unique numbers for each syscall. Both user program and kernel include this header so they agree on what each number means.

### 1.2 The Core Syscall Function (`user_lib.c`)

```c
int syscall(int sysno, int arg0, int arg1, int arg2) {
  register int a0 __asm__("a0") = arg0;
  register int a1 __asm__("a1") = arg1;
  register int a2 __asm__("a2") = arg2;
  register int a3 __asm__("a3") = sysno;

  __asm__ __volatile__("ecall"
                       : "=r"(a0)
                       : "r"(a0), "r"(a1), "r"(a2), "r"(a3)
                       : "memory");

  return a0;
}
```

#### Step-by-step breakdown:

1. **Place arguments in specific registers**
   - `a0`, `a1`, `a2` hold the syscall arguments (up to 3 arguments)
   - `a3` holds the syscall number (e.g., `SYS_PUTCHAR = 1`)
   - This is a **calling convention** - the kernel expects arguments in these exact registers

2. **Trigger the trap with `ecall`**
   - The `ecall` instruction causes the CPU to:
     - Stop executing user code
     - Switch to supervisor (kernel) mode
     - Jump to the kernel's trap handler
   - Inline assembly syntax:
     - `"ecall"` - the instruction to execute
     - `: "=r"(a0)` - **output**: after `ecall` returns, read `a0` back (return value)
     - `: "r"(a0), "r"(a1), "r"(a2), "r"(a3)` - **inputs**: registers that must be set before `ecall`
     - `: "memory"` - **clobber**: tells compiler memory might change

3. **Return the result**
   - The kernel puts its return value in `a0`, which we return to the caller

### 1.3 Wrapper Functions

```c
void putchar(char ch) { syscall(SYS_PUTCHAR, ch, 0, 0); }
int getchar(void) { return syscall(SYS_GETCHAR, 0, 0, 0); }

__attribute__((noreturn)) void exit(void) {
  syscall(SYS_EXIT, 0, 0, 0);
  for (;;);  // Safety loop - should never reach here
}
```

| Function | What it does |
|----------|--------------|
| `putchar(ch)` | Asks kernel to print character `ch` |
| `getchar()` | Asks kernel to read a character, returns it |
| `exit()` | Asks kernel to terminate this process |

---

## Part 2: C Runtime Startup (`crt.c`)

The CRT (C Runtime) is the very first code that runs when a user program starts.

```c
extern char __stack_top[];

__attribute__((section(".text.start"))) __attribute__((naked)) void
start(void) {
  __asm__ __volatile__("mv sp, %[stack_top] \n"
                       "call main           \n"
                       "call exit           \n" ::[stack_top] "r"(__stack_top));
}
```

### Key components:

| Element | Purpose |
|---------|---------|
| `__stack_top` | External symbol from linker script marking top of stack memory |
| `section(".text.start")` | Places function in special section that linker puts first |
| `naked` | No compiler-generated prologue/epilogue (we set up stack ourselves) |

### The three instructions:

1. **`mv sp, %[stack_top]`** - Initialize stack pointer (grows downward in RISC-V)
2. **`call main`** - Call the user's actual program
3. **`call exit`** - When main returns, cleanly terminate via syscall

### User Program Lifecycle:

```
Kernel loads user program and jumps to it
                ↓
        start() runs first
                │
        ┌───────┴───────┐
        │ 1. Set up stack│
        │ 2. Call main() │
        │ 3. Call exit() │
        └───────┬───────┘
                ↓
        exit() syscall → kernel terminates process
```

---

## Part 3: Kernel Trap Handling

### 3.1 The Trap Handler (`trap.c`)

```c
void handle_trap(struct trap_frame *f) {
  uint32_t scause = READ_CSR(scause);
  uint32_t stval = READ_CSR(stval);
  uint32_t user_pc = READ_CSR(sepc);

  if (scause == SCAUSE_ECALL) {
    handle_syscall(f);
    user_pc += 4;  // Skip past ecall instruction (4 bytes)
  } else {
    PANIC("unexpected trap scause=%x, stval=%x, sepc=%x\n", scause, stval, user_pc);
  }

  WRITE_CSR(sepc, user_pc);
}
```

#### CSR (Control and Status Registers):

| Register | Purpose |
|----------|---------|
| `scause` | Why the trap happened (syscall? page fault? illegal instruction?) |
| `stval` | Extra info (e.g., bad address for page fault) |
| `sepc` | User's program counter - where to return after handling |

`SCAUSE_ECALL = 8` is the RISC-V code for "environment call from U-mode".

### 3.2 The Syscall Handler (`kernel.c`)

```c
void handle_syscall(struct trap_frame *f) {
  switch (f->a3) {
  case SYS_PUTCHAR:
    putchar(f->a0);
    break;
  case SYS_GETCHAR:
    while (1) {
      long ch = getchar();
      if (ch >= 0) {
        f->a0 = ch;  // Return value to user space!
        break;
      }
      yield();
    }
    break;
  case SYS_EXIT:
    printf("process %d exited\n", current_proc->pid);
    current_proc->state = PROC_EXITED;
    yield();
    PANIC("unreachable");
  default:
    PANIC("unexpected syscall a3=%x\n", f->a3);
  }
}
```

### 3.3 Where is `trap_frame` Saved?

The `trap_frame` is saved **on the kernel stack** of the current process.

#### Memory Layout:

```
                HIGH ADDRESS
┌─────────────────────────────────┐
│      Kernel Stack Top           │ ← sscratch points here initially
├─────────────────────────────────┤
│        trap_frame               │ ← sp after "addi sp, sp, -4*31"
│        (31 registers)           │   This is passed to handle_trap()
│        (124 bytes)              │
├─────────────────────────────────┤
│    handle_trap's stack frame    │
└─────────────────────────────────┘
                LOW ADDRESS
```

#### `kernel_entry` assembly flow:

1. **`csrrw sp, sscratch, sp`** - Atomically swap user sp ↔ kernel sp
2. **`addi sp, sp, -4 * 31`** - Allocate 124 bytes for trap_frame
3. **`sw` instructions** - Save all 31 registers to stack
4. **`mv a0, sp`** - Pass trap_frame pointer as argument
5. **`call handle_trap`** - Handle the trap
6. **`lw` instructions** - Restore all registers (including modified `a0`!)
7. **`sret`** - Return to user mode

---

## Part 4: The Shell (`shell.c`)

The shell demonstrates how user programs use syscalls:

```c
void main(void) {
  while (1) {
  prompt:
    printf("> ");
    char cmdline[128];
    for (int i = 0;; i++) {
      char ch = getchar();  // SYS_GETCHAR syscall
      putchar(ch);          // SYS_PUTCHAR syscall (echo)
      if (i == sizeof(cmdline) - 1) {
        printf("command line too long\n");
        goto prompt;
      } else if (ch == '\r') {  // Enter key
        printf("\n");
        cmdline[i] = '\0';
        break;
      } else {
        cmdline[i] = ch;
      }
    }

    if (strcmp(cmdline, "hello") == 0)
      printf("Hello world from shell!\n");
    else if (strcmp(cmdline, "exit") == 0)
      exit();  // SYS_EXIT syscall
    else
      printf("unknown command: %s\n", cmdline);
  }
}
```

---

## Complete System Flow Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                         USER SPACE                                 │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  shell.c                                                     │  │
│  │    └─► printf(), getchar(), putchar(), exit()               │  │
│  │    └─► user_lib.c: syscall() ─► ecall instruction           │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  crt.c: start() → setup stack → main() → exit()             │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
                               │ ecall
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│                        KERNEL SPACE                                │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  trap.c: kernel_entry() → save registers → handle_trap()    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  trap.c: handle_trap() → check scause → handle_syscall()    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  kernel.c: handle_syscall() → dispatch based on syscall #   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

---

## Future: musl and Toybox Integration

### Syscall Convention Changes Needed

Current os1k uses a **custom convention**:
- Syscall number in `a3`
- Arguments in `a0`, `a1`, `a2`

musl expects **Linux RISC-V convention**:
- Syscall number in `a7`
- Arguments in `a0`-`a5`
- Negative return values indicate errors (-errno)

### Syscall Requirements

| Goal | Syscalls Needed | Notes |
|------|-----------------|-------|
| musl "Hello World" | ~10 | `write`, `exit`, `brk`, stubs |
| toybox `echo` | ~10 | Same as above |
| toybox `cat` | ~20 | + `open`, `read`, `close`, `fstat` |
| toybox `ls` | ~30 | + `getdents64`, `getcwd` |
| toybox `sh` | ~50-60 | + `fork`, `execve`, `wait4`, `pipe`, signals |

### Key Linux Syscall Numbers (RISC-V)

| Syscall | Number |
|---------|--------|
| read | 63 |
| write | 64 |
| openat | 56 |
| close | 57 |
| fstat | 80 |
| exit_group | 94 |
| brk | 214 |
| mmap | 222 |
| getdents64 | 61 |

### Practical Roadmap

1. **Phase 1**: Get musl "hello world" working (~10 syscalls, no filesystem)
2. **Phase 2**: Build toybox with only "echo" (proves integration works)
3. **Phase 3**: Add simple in-memory filesystem (ramfs)
4. **Phase 4**: Add "cat" to toybox (test file reading)
5. **Phase 5**: Add "ls" (need `getdents64`)
6. **Phase 6**: Gradually add more commands and syscalls

### Important Note

**Filesystem is the bigger blocker** than syscalls for most toybox commands. Without filesystem, only commands like `echo`, `true`, `false`, `yes`, `sleep` work.

---

## Files Modified in This Commit

| File | Purpose |
|------|---------|
| `syscall.h` | Define syscall numbers |
| `user_lib.c` | User-side syscall wrapper functions |
| `crt.c` | C runtime startup code |
| `user.h` | User-space function declarations |
| `trap.c` | Kernel trap handler |
| `kernel.c` | Syscall dispatch and handling |
| `kernel.h` | Kernel constants (`SCAUSE_ECALL`, `PROC_EXITED`) |
| `shell.c` | Interactive shell using syscalls |
| `run.sh` | Build script updated for new files |
