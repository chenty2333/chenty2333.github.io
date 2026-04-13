## 你的任务

跟随 `main.c` 中 `TODO` 注释的指引：

1. **初始化**：调用 `thread_pool_init`，创建一个包含 4 个 Worker 的线程池。
2. **派发任务**：写个循环，把每张图的 `BatchTask` 准备好，通过 `submit` 丢给线程池。
3. **等待**：调用 `thread_pool_wait` 等待所有打工线程把活干完。
4. **退出**：调用 `thread_pool_destroy` 回收资源。

### 扩展玩法：自定义 Config

注意看 `execute_jobs` 这个函数的签名：

```c
static int execute_jobs(const ImageJob jobs[], const FilterConfig* config, ImageResult results[], int job_count)
```

在这个程序里，运行逻辑是这样的：`main` 函数调用了 `pipeline_run_image_batch(execute_jobs)`。底层测试框架会准备好各种参数的默认值（比如默认的中值滤波、半径为 1 的配置），然后把它们作为参数传给 `execute_jobs` 这个函数。

但既然我们已经把“任务数据”和“算法配置”解耦了，你完全可以不使用外部传进来的默认 `config`！你可以自己在 `execute_jobs` 内部定义一个局部变量，捏一个全新的配置。

打开 `src/common/filter.h`，可以看到配置结构体非常简单：

```c
typedef struct {
  FilterKind kind;
  int median_radius;
} FilterConfig;
```

**怎么把自定义配置传进去？**

你可以在 `execute_jobs` 函数内的开头部分定义你的专属配置。比如继续使用中值滤波，但把半径改大一些：

```c
FilterConfig my_config;
my_config.kind = FILTER_KIND_MEDIAN;
my_config.median_radius = 2;
```

然后在打包任务的 `for` 循环里，把原本的 `config` 换成你的 `&my_config`：

```c
for (i = 0; i < job_count; ++i) {
    tasks[i].job = &jobs[i];
    // 原本是：tasks[i].config = config;
    tasks[i].config = &my_config; // <-- 偷天换日！换成你自己的配置地址
    tasks[i].result = &results[i];
    
    // 丢进线程池
    // thread_pool_submit(...)
}
```

注意：因为 `execute_jobs` 会调用 `thread_pool_wait` 等待所有线程干完活才 `return`，所以在等待期间，你的局部变量 `my_config` 的内存是绝对安全的，打工线程可以放心地读取它！

去跑一遍看看 `output/ch4/metrics.csv` 里的 PSNR 和 SSIM 是不是变高了？这就是软件工程里“配置化”的好处：改一行配置，就能瞬间切换底层复杂的算法引擎，而你的并发代码一行都不用动！

### 感受速度吧！

编译运行你的代码，对比一下单线程时的耗时，多核并行的提速是肉眼可见的。
去跑一遍 `autograde.sh`，看着全绿的 `PASS`，为自己手搓出这一切鼓个掌吧！(๑•̀ㅂ•́)و✧
