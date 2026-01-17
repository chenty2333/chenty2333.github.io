# CSAPP 3.6

| 指令         | 同义名 | 跳转条件         | 描述                    |
| ------------ | ------ | ---------------- | ----------------------- |
| jmp Label    |        | 1                | 直接跳转                |
| jmp *Operand |        | 1                | 间接跳转                |
| je Label     | jz     | ZF               | 相等/零                 |
| jne Label    | jnz    | ~ZF              | 不相等/非零             |
| js Label     |        | SF               | 负数                    |
| jns Label    |        | ~SF              | 非负数                  |
| jg Label     | jnle   | ~(SF ^ OF) & ~ZF | 大于 ( 有符号 > )       |
| jge Label    | jnl    | ~(SF ^ OF)       | 大于或等于 ( 有符号>= ) |
| jl Label     | jnge   | SF ^ OF          | 小于 ( 有符号< )        |
| jle Label    | jng    | (SF ^ OF) \| ZF  | 小于或等于 ( 有符号<= ) |
| ja Label     | jnbe   | ~CF & ~ ZF       | 超过 ( 有符号> )        |
| jae Label    | jnb    | ~CF              | 超过或相等 ( 无符号>= ) |
| jb Label     | jnae   | CF               | 低于 ( 无符号< )        |
| jbe Label    | jna    | CF \| ZF         | 低于或相等 ( 无符号<= ) |

## 条件分支

### 3.6.5 条件控制

一般形式:

```c
	t = test-expr;
	if (!t)
		goto false;
	then-statement
	goto done;
flase:
	else-statement
done:
```

不用

```c
	t = test-expr;
	if (t)
        goto ture;
	else-statement
    goto done;
true:
	then-statement
done:
```

的原因: 对于没有else条件的语句, 第一种情况更优.

### 条件传送

分支中无副作用时, 可以使用:

```c
v = then-expr;
ve = else-expr
t = test-expr;
if (!t) v = ve;
```

为什么用条件传送?

处理器流水线通过重叠执行连续指令的步骤 ( 取指令, 算术运算, 写数据) 提高性能. 若遇到条件跳转时, 通过分支预测决定分支走向, 错误预测会导致惩罚.

但处理器无需预测就可以执行条件传送.

## 循环

### do-while

```c
loop:
	body-statement
	t = test-expr;
	if (t)
		goto loop;
```

### while

```c
	goto test;
loop:
	body-statement
test:
	t = test-expr;
	if (t)
		goto loop;
```

**guarded-do**

```c
t = test-expr;
if (!t)
	goto done;
loop:
	body-statement
	t = test-expr;
	if (t)
		goto loop;
done:
```

guarded-do方便编译器优化初始测试, 如: 认为测试条件总是满足/不满足.

## for循环

等价于:

```c
init-expr;
while (test-expr) {
	body-statement
	update-expr;
}
```

```c
	init-expr;
	goto test;
loop:
	body-statement
	update-expr;
test:
	t = test-expr;
	if (t)
		goto loop;
```

guarded-do:

```c
	init-expr
	t = test-expr;
	if (!t)
		goto done;
loop:
	body-statement
	update-expr;
	t = test-expr;
	if (t)
		goto loop;
done:
```

## switch

例子:

```c
void switch_eg(long x, long n, long *dest)
{
	long val = x;
	
	switch (n) {
	
	case 100:
		val *= 13;
		break;
		
	case 102:
		val += 10;
		
	case 103:
		val += 11;
		break;
	case 104:
	case 106:
		val *= val;
		break;
	
	default:
		val = 0;
	}
	*dest = val;
}
```

```c
void switch_eg_impl(long x, long n, long *dest)
{
	static void *jt[7] = {
		&&loc_A, &&loc_def, &&loc_B,
		&&loc_C, &&loc_D, &&loc_def,
		&&loc_D
	};
	unsigned long index = n - 100;
	long val;
	
	if (index > 6)
		goto &&loc_def;
	goto *jt[index];
	
loc_A:		/* Case 100 */
	val = x * 13;
	goto done;
loc_B:		/* Case 102 */
	x = x + 10;
	/* Fall through */
loc_C:		/* Case 103 */
	val = x + 11;
	goto done;
loc_D:		/* Cases 104, 106 */
	val = X * x;
	goto done;
loc_def:	/* Default case */
	val = 0;
done:
	*dest = val;
}
```

```nasm
switch_eg:
	subq	$100, %rsi						Compute index = n-100
	cmpq	$6, %rsi						Compare index:6
	ja		.L8								If >, goto loc_def
	jmp		*.L4(,%rsi,8)					Goto *jt[index]
.L3:									  loc_A:
	leaq	(%rdi,%rdi,2), %rax				3*x
	leaq	(%rdi,%rax,4), %rdi				val = 13*x
	jmp		.L2								Goto done
.L5:									  loc_B:
	addq	$10, %rdi						x = x + 10
.L6:									  loc_C:
	addq	$11, %rdi						val = x + 11
	jmp		.L2								Goto done
.L7:									  loc_D:
	imulq	%rdi, %rdi						val = x * x
	jmp		.L2								Goto done
.L8:									  loc_def:
	movl	$0, %edi						val = 0
.L2:									  done:
	movq	%rdi, (%rdx)					*dest = val
	ret										Return
	
	
	
  .section		.rodata
  .aligh 8									Aligh address to multiple of 8
.L4:
  .quad		.L3								case 100: loc_A
  .quad		.L8								case 101: loc_def
  .quad		.L5								case 102: loc_B
  .quad		.L6								case 103: loc_C
  .quad		.L7								case 104: loc_D
  .quad		.L8								case 105: loc_def
  .quad		.L7								case 106: loc_D
```


