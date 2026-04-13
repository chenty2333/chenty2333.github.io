# 全新篇章!

在这一章，也就是 Chapter 3，我们会自己动手实现一个线程池! 听起来是不是超级厉害(≧∇≦)ﾉ

会有一点难度, 但是耐心肯定能解决的, 方法总比困难多!

首先我们需要知道什么是"锁"

还记得 ch1 中我们说的“临界资源”嘛？简单回顾下，"临界资源" 同一时刻只能被一个线程拥有。 硬件和操作系统不像人一样. 如果是人, 当多个人都想使用卫生间的时候, 能快速讨论出一个使用顺序, 但是对于计算机, 我们必须在资源上显式地加一个标志, 告诉计算机现在谁能拥有这个被多个线程共享的"临界资源".

所以我们需要"锁", 用一把"锁"把共享资源锁住, 同时只给多个线程一把钥匙. 谁抢到谁就能"解锁".
锁是通过硬件提供的指令和操作系统在软件层面共同实现的. 可以说"锁"是一种特殊类型的变量, 虽然"锁"不是我们接触过的INT/DOUBLE之类的类型. 

> **扩展知识：Mutex vs Spinlock**
>
> 刚才说的 Mutex（互斥锁），抢不到锁的线程就会去睡觉（交出 CPU 控制权）。在操作系统底层，**每一个需要被保护的“临界资源”都会关联一个属于自己的等待队列（Waitqueue）**。抢不到这把锁的线程，会被操作系统放进这个资源专属的 Waitqueue 里排队并挂起休眠；等锁被释放时，操作系统再从这个队列里唤醒线程。这种做法虽然不占用 CPU，但“睡觉”和“被唤醒”的过程需要操作系统介入，进行上下文切换（Context Switch），开销很大。
> 那如果是极短时间就能干完的活呢？我们就用 Spinlock（自旋锁）。打工人不睡觉，也不去 Waitqueue 里排队，就在门口死盯着（利用硬件提供的 CAS 等原子指令，在一个死循环里疯狂重试），一旦锁解开就立马冲进去。这是一种“拿 CPU 烧电费换取极致响应速度”的做法。
> 相关名词可自行查阅，此处只做介绍，不多赘述。

不要多想, 锁真的只有我们上面说的那么简单. 背后没有那么多玄奥秘密, 锁就是为了锁住资源. 当然锁的实现也有不同方式, 锁的使用场景也是千奇百怪. 不过这些都不是现在我们需要考虑的.

来看看在多线程编程中, 怎么使用锁吧.

C/C++提供了pthread, 也就是POSIX Thread.

在ch3中我们会使用几个简单的API.

首先是pthread_mutex.

上面说了, 锁也是一种类型的变量. 在pthread中, 我们可以使用
pthread_mutex_t x; 定义一个叫做x的锁, mutex就是互斥的意思. "互斥"就是字面含义, 一个线程持有互斥锁, 其他线程就无法同时再持有互斥锁.

在 `thread_pool` 中:
```c
typedef struct {
  pthread_t* threads;
  ThreadTask* queue;
  int thread_count;
  int queue_capacity;
  int queue_size;
  int queue_head;
  int queue_tail;
  int stop;
  int working_count;
  pthread_mutex_t mutex;    // 定义了一个名为mutex的互斥锁
  pthread_cond_t not_empty;
  pthread_cond_t not_full;
  pthread_cond_t all_done;
} ThreadPool;
```
我们在一个名为 `ThreadPool` 的结构体中定义了一把名为 `mutex` 的互斥锁。放在 `ThreadPool` 中是因为我们希望 `pthread_mutex_t mutex` 能保护住整个 `ThreadPool` 结构体。


那要怎么使用这把锁呢？主要就是两个动作：**加锁 (lock)** 和 **解锁 (unlock)**。

```c
pthread_mutex_lock(&pool->mutex);   // 抢锁！抢不到的线程会在这里乖乖排队睡觉
// ... 这里是对共享资源（比如任务队列）的修改 ...
pthread_mutex_unlock(&pool->mutex); // 完事了，把锁解开，下一个排队的线程会被唤醒
```

只有在 `lock` 和 `unlock` 之间的代码，才是绝对安全的。这就是我们常说的“临界区”。"临界区"就是指访问共享资源(临界资源)的代码段.

### 如果队列是空的怎么办？—— 条件变量 (Condition Variable)

想象一下这个场景：我们的线程池里有 4 个打工线程（Worker），它们抢到了锁，打开任务队列一看，哎呀，队列里居然没有任务！(你可能疑惑什么是"任务队列", 现在就当成一个TODO List, 文档的后半段会讲解的, 现在不用在意)

这时候打工线程该怎么办呢？
- **死循环狂刷？** （比如 `while(queue_size == 0) {}`）—— 绝对不行！这叫忙等待（Busy Waiting），会让 CPU 占用率飙升到 100%，风扇狂转。
- **解锁然后睡一会儿再看？** —— 听起来不错，但睡多久呢？睡长了会延迟任务的处理，睡短了还是浪费 CPU。

为了解决这个问题，操作系统(pthread)给我们提供了一个超级好用的工具：**条件变量 (`pthread_cond_t`)**。

条件变量就像是一个**大喇叭**和一个**休息室**。
当打工线程发现没有任务时，它就拿着锁走进休息室睡觉（`pthread_cond_wait`）。当老板（主线程）往队列里塞了一个新任务后，老板就会拿起大喇叭喊一嗓子（`pthread_cond_signal`），把在休息室里睡觉的打工线程叫醒一个起来干活。

注意：大喇叭有两种，`pthread_cond_signal` 只叫醒**一个**睡觉的线程，而 `pthread_cond_broadcast` 才是同时唤醒**所有**睡觉的线程！

在我们的结构体里，定义了三个条件变量：
- `not_empty`：队列不为空啦！打工线程可以通过它来等待新任务。
- `not_full`：队列没满啦！老板（提交任务的线程）可以通过它来等待队列腾出空位。
- `all_done`：活全干完啦！用来等待所有任务执行完毕。

### 条件变量怎么用？(重难点预警 ⚠️)

条件变量**必须**和互斥锁搭配使用！这是很多初学者最容易栽跟头的地方。

假设我们是一个 Worker 线程，想要等待任务到来，代码看起来是这样的：

```c
pthread_mutex_lock(&pool->mutex); // 1. 先加锁

// 2. 用 while 循环判断条件（必须是 while，不能是 if！）
while (pool->queue_size == 0 && pool->stop == 0) {
    // 3. 开始睡觉！
    // 注意：pthread_cond_wait 在睡觉的瞬间，会自动把 mutex 解锁！
    // 等它被别人叫醒的时候，又会在内部自动重新抢到 mutex！
    pthread_cond_wait(&pool->not_empty, &pool->mutex);
}

// 4. 被叫醒了，且 queue_size > 0 ！从队列中取出任务，更新 queue_size 和 queue_head 等状态...

pthread_mutex_unlock(&pool->mutex); // 5. 关键：拿到任务后，先解锁！！！

// 6. 真正开始干活（千万别拿着锁干活，不然别人连任务都领不到！）
// task.fn(task.arg);

// 7. 干完活后，可能还需要重新加锁更新一下 working_count，然后发个 all_done 广播.
```

**为什么一定要用 `while` 而不是 `if` 呢？**
因为线程被大喇叭唤醒的那一瞬间，到它真正抢到锁去执行代码之间，可能发生了其他事情（比如另一个手速快的线程把任务抢走了），这就是所谓的“虚假唤醒”（Spurious Wakeup）。所以醒来后，必须再确认一下条件到底满不满足。

相反，老板（主线程）提交任务的逻辑就是：

```c
pthread_mutex_lock(&pool->mutex);
// 塞入任务，修改 queue_size ...
pthread_cond_signal(&pool->not_empty); // 拿起喇叭：有新任务啦！醒醒！
pthread_mutex_unlock(&pool->mutex);
```

> **小贴士 (Tip)**: `pthread_cond_signal` 是唤醒至少一个线程，而 `pthread_cond_broadcast` 是把所有在休息室睡觉的线程全叫醒。

### 生产者 - 消费者模型 与 环形队列

是不是觉得刚才的“老板塞任务，工人做任务”的模式很熟悉？
没错，这就是计算机科学中非常经典的**生产者-消费者模型 (Producer-Consumer Model)**。

- **生产者 (Producer)**：就是调用 `thread_pool_submit` 函数的线程。它负责把任务源源不断地塞进 `pool->queue` 中。如果队列满了，它就要等 (`not_full`)。
- **消费者 (Consumer)**：就是那些 Worker 线程（`thread_pool_worker`）。它们在后台不断地从队列里取任务并执行。如果队列空了，它们就要等 (`not_empty`)。

细心的你可能注意到了结构体里的 `queue_head`、`queue_tail` 和 `queue_capacity`。没错，我们这里的 `pool->queue` 是一个**环形队列 (Circular Queue)**！

为什么是环形？因为我们的队列数组大小是固定的（`queue_capacity`）。如果打工线程从头拿任务（`head++`），老板往尾部塞任务（`tail++`），那数组很快就会走到尽头越界，而前面被拿走任务腾出来的空间却被浪费了。

所以，当我们走到数组尾部时，要绕回头部！这在代码里只需要一个简单的取余操作（`%`）：

```c
// 老板塞入任务后，尾指针后移：
pool->queue_tail = (pool->queue_tail + 1) % pool->queue_capacity;

// 打工人取出任务后，头指针后移：
pool->queue_head = (pool->queue_head + 1) % pool->queue_capacity;
```
是不是很精妙？用固定大小的数组就能实现一个无限循环利用的队列！

### 等待任务完成：为什么需要 working_count？

在 `thread_pool_wait` 的 TODO 中，你会发现我们要检查 `queue_size == 0` 且 `working_count == 0`。很多聪明的同学会产生疑问：“既然 `queue_size == 0`（队列空了），不就说明活儿干完了吗？为什么还要多此一举看 `working_count`？”

大家思考一个场景：老板往队列里放了最后一个任务，打工人 A 拿走了这个任务。此时 `queue_size` 变成了 0。老板一看队列空了，以为全都搞定了，准备继续往下走。但他没看到的是，打工人 A 还在工位上满头大汗地跑着这最后一个任务的代码呢！

这就是为什么我们需要 `working_count`（正在干活的线程数）。只有当**“待办列表是空的” (`queue_size == 0`) 且 “没有人还在工位上忙” (`working_count == 0`)** 时，才是真正的万事大吉。

### 如何优雅地下班？(pthread_join)

最后，当老板决定关门不干了（调用 `thread_pool_destroy`），他不能直接拔电源（强制杀掉线程），因为这样会把正在执行的任务搞坏，还会造成内存泄漏。

我们需要让老板告诉所有人“准备下班啦”（先加锁，设置 `pool->stop = 1`，再解锁）。
但这就够了吗？不够！回忆一下刚才讲的条件变量：有些打工线程可能正因为队列为空，而在 `not_empty` 这个条件变量专属的 Waitqueue 里呼呼大睡呢！如果不把它们叫醒，它们会睡到地老天荒，导致程序永远卡住无法退出。

所以，老板必须拿起大喇叭，用 `pthread_cond_broadcast(&pool->not_empty)` 把所有在睡觉的员工全部叫醒。
打工线程被唤醒后，会重新抢锁，并再次检查 `while` 循环的条件或者 `if (stop == 1 && queue_size == 0)`。一看 `stop == 1` 了，就知道“哦，没活干而且关门大吉了”，于是直接跳出循环，结束线程函数（`return NULL;`）。

最后，老板要站在门口，亲自清点人数，等每一个员工收拾好东西走人。这就要用到一个 `for` 循环和 `pthread_join`：

```c
for (int i = 0; i < pool->thread_count; ++i) {
  pthread_join(pool->threads[i], NULL);
}
```

```c
pthread_join(thread_id, NULL);
```
这个函数会让调用它的线程（比如老板）阻塞在这里，一直等到指定的 `thread_id` 线程安全退出（也就是 `thread_pool_worker` 函数执行完毕 `return NULL;` 了），老板才会继续往下走。这样就能保证所有的打工人都被妥善安置啦！

### 补充小知识：函数指针与 `void*`

在上面第 6 步，我们提到了执行任务：`task.fn(task.arg);`，这里涉及到 C 语言里一个非常强大但容易让人头晕的特性——**函数指针**。

看看我们 `thread_pool.h` 头文件里定义的 `ThreadTask`：

```c
typedef void (*thread_task_fn)(void*);

typedef struct {
  thread_task_fn fn;
  void* arg;
} ThreadTask;
```

- `thread_task_fn` 是一个自定义类型，它表示**“指向一个函数的指针”**。这个函数长什么样呢？它必须接收一个 `void*` 类型的参数，并且没有返回值（`void`）。
- `void*` 是什么？它是 C 语言里的“万能指针”，可以指向任何类型的数据（比如整型数组、图片结构体等等）。因为写线程池的时候，我们根本不知道未来别人会丢给它什么奇怪的任务、需要什么复杂的参数，所以我们统一用 `void*` 接收。等真正在任务函数内部执行时，再把它强转回原来的类型就行了。

所以，把任务塞进队列，其实就是把**“要执行的函数地址 (`fn`)”**和**“这个函数的参数地址 (`arg`)”**打包成一个 `ThreadTask` 结构体存起来。等打工线程从队列里拿到这个包裹，直接调用 `fn(arg)` 就可以开始干活啦！

### 你的任务 (TODO)

在 `src/ch3/thread_pool.c` 中，我们已经帮你搭好了骨架，并在关键的地方留下了 `TODO` 注释。

你需要完成：
1. **`thread_pool_worker`**：实现消费者的逻辑。让它能安全地等待任务、取出任务，修改 `queue_size` / `queue_head` / `working_count`，并在干完活后更新状态。
2. **`thread_pool_submit`**：实现生产者的逻辑。安全地把新的任务塞进环形队列的尾部（更新 `queue_tail` 和 `queue_size`），并唤醒睡觉的打工人。
3. **`thread_pool_wait`**：让主线程在这里乖乖等所有的任务都被打工人处理完（当 `queue_size == 0` 且 `working_count == 0` 时）。
4. **`thread_pool_destroy`**：安全下班！通知所有线程退出，并用 `pthread_join` 回收它们。

这可能是你写过的最复杂的 C 语言多线程代码之一了。如果卡住了，多回头看看上面条件变量配合 `while` 循环的那个例子，想想加锁和解锁的时机。

加油！写出自己的线程池，成就感绝对是无与伦比的！(๑•̀ㅂ•́)و✧
