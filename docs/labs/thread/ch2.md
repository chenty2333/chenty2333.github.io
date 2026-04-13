# 恭喜来到 ch2 的实验！

做完 ch1，大家有没有好奇，我们 ch1 的 `main.c` 到底在做什么？

```c
#include "common/pipeline.h"

static int execute_jobs(const ImageJob jobs[], const FilterConfig* config, ImageResult results[],
                        int job_count) {
  int i;

  for (i = 0; i < job_count; ++i) {
    pipeline_process_one_image(&jobs[i], config, 1, &results[i]);
  }

  return 0;
}

int main(void) {
  return pipeline_run_image_batch(execute_jobs);
}
```

我们可以看到，`pipeline_process_one_image()` 被封装成一个 job 传递给
`pipeline_run_image_batch()`。

那 `pipeline_process_one_image()` 这个函数，究竟是怎么 “process one image” 的呢？照片在其中是如何被处理的？

可以尝试在 IDE 中按下 `Ctrl`，然后点击 `pipeline_process_one_image()`，IDE 会带你跳转到函数定义的位置，也就是 `pipeline.c` 这个文件。

### 先看整体流程

快速过一下初始的流程吧！

首先，我们检查函数输入的参数是否合法。

其次会对保存输出结果的缓冲区做清零工作，防止缓冲区中残留的数据污染我们的 output。

然后读取图片，如果图片加载成功且图片符合要求，我们就做后续的处理。如果没有加载成功或者不符合要求，就做清理工作，把分配出来用来放图片的缓冲区清理掉，之后终止程序，返回非 0 的错误码。

也就是下面这段代码：

```c
if (job == NULL || config == NULL || out_result == NULL) {
  return -1;
}

pipeline_reset_result(out_result);

if (image_load_png(job->input_path, &input) != 0 || image_load_png(job->gt_path, &gt) != 0) {
  out_result->status_code = PIPELINE_STATUS_LOAD;
  image_free(&input);
  image_free(&gt);
  return -1;
}

if (input.width != gt.width || input.height != gt.height || input.channels != gt.channels) {
  out_result->status_code = PIPELINE_STATUS_SHAPE;
  image_free(&input);
  image_free(&gt);
  return -1;
}

if (image_allocate_like(&input, &output) != 0) {
  out_result->status_code = PIPELINE_STATUS_LOAD;
  image_free(&input);
  image_free(&gt);
  return -1;
}
```

你看，读代码其实也没有那么困难吧。有时候我们可以从一个宏观的视角去阅读代码，主要看函数名和函数接受的参数，就大概能了解到它的功能是什么。至于函数内部具体是如何实现的，采取什么样的算法，其实不用太纠结，需要的时候再去看就好啦~~

我们继续ヾ(≧▽≦*)o

### 为什么要算两次 PSNR

```c
metrics_compute_psnr(&input, &gt, &out_result->psnr_before);
if (compute_ssim) {
  if (metrics_compute_ssim(&input, &gt, &out_result->ssim_before) != 0) {
    ...
  }
}

/* ... */

metrics_compute_psnr(&output, &gt, &out_result->psnr_after);
if (compute_ssim) {
  if (metrics_compute_ssim(&output, &gt, &out_result->ssim_after) != 0) {
    ...
  }
  ...
}
```
可以看到执行了两次 `metrics_compute_psnr()`，

一次是 `metrics_compute_psnr(&input, &gt, &out_result->psnr_before)`。

另一次是 `metrics_compute_psnr(&output, &gt, &out_result->psnr_after)`；

仔细看，两者长得很像，但是第三个参数变了，从 `before` 变成了 `after`。

这中间发生了什么呢？

在 `pipeline.c` 中，我们主要是做了：

```c
if (filter_apply(&input, &output, config) != 0) {
  out_result->status_code = PIPELINE_STATUS_FILTER;
  image_free(&input);
  image_free(&gt);
  image_free(&output);
  return -1;
}

if (image_save_png(job->output_path, &output) != 0) {
  out_result->status_code = PIPELINE_STATUS_SAVE;
  image_free(&input);
  image_free(&gt);
  image_free(&output);
  return -1;
}
```

`filter_apply(&input, &output, config) != 0` 的意思就是检查 `filter_apply` 函数的输出是不是 `0`，`0` 的话代表函数执行成功。如果返回值非零，就执行 `image_free`，也就是清理工作。感兴趣可以 `Ctrl` 点击对应的 `free` 函数看看具体是怎么做清理的。

具体到 `filter_apply`，大概就是对图片做了一次中值滤波。

### 什么是中值滤波

首先要介绍一个参数，`median_radius`，正如字面意思，半径。如果 `median_radius = 1`，就是取当前像素，比如像素 `X` 周围半径为 1 像素的区域。也就是 9 个点。

既然是“中值”滤波，那我们就把 9 个点排序，然后把这个中值赋值给 `X`。

为什么要这么做呢？大家在夜间或者暗光环境下拍照，都遇到过噪点吧。我们能看到噪点是因为噪点的颜色和周围不同，也就是噪点的值和周围正常像素值的差异巨大。使用中值滤波的话，由于噪点要么是最大要么是最小，不会在中位数的区间，所以我们把中位数赋值给噪点这个像素，就能起到降噪的效果。当然，这也会牺牲图片的质量。我们是对整个图片每个像素都做“中值滤波”操作，所以有些“无辜像素”会被误杀，图片清晰度或者说锐度就下降了。

比如：

```text
10  11  12
12 250  13
11  12  10
```

这是以 `250` 为中心，半径为 `1` 的区域。使用中值滤波，就会变成

```text
10  11  12
12  12  13
11  12  10
```

### 什么是双边滤波

双边滤波为了解决中值滤波锐度下降的问题，决定给每个像素赋一个权重 `W_i`，具体就是：

$$
\text{新的像素值}
= \frac{\sum \left(\text{邻域像素值} \times \text{对应权重}\right)}{\sum \text{所有权重}}
$$

直觉上就是：

- 离中心越远，权重越小。
- 和中心差得越多，权重越小。
- 又近又像的像素，权重最大。

‘离中心越远权重越小’，这叫空间距离，就像近视眼看东西，越远的越模糊；‘和中心差得越多权重越小’，这叫色彩差异（值域），目的是为了保护图像的‘边界’不被糊掉——因为边界两边的像素值通常差异很大。两者结合，就做到了只把同一块平缓区域内的噪点抹平，而保留了物体清晰的轮廓。

所以双边滤波更擅长做的事情，是在平滑噪声的同时，尽量不要把边缘直接平均掉。

比如前面那个例子：

```text
10  11  12
12 250  13
11  12  10
```

经过双边滤波后，中心像素**可能**会被拉回一些，变成类似这样：

```text
10  11  12
12 150  13
11  12  10
```

注意，这个结果不是固定的，只是一个帮助理解的例子。真正的结果会受到权重计算方式的影响。

### 为什么 RGB 最后变成了一个值

可能会有人有疑惑，“据我了解像素是 RGB 三种颜色呀，为什么在你这表现就是一个值？”因为我们实验都是拿灰度值，也就是“从白到黑”，一个单通道的值表示像素。RGB 三通道也可以通过某种计算，得到一个“灰度值”，代价就是信息的损失，不过这没关系，我们简化了计算。即使要对 RGB 图计算，也有办法。

大家可以试着把文档复制给豆包（或者别的啥 AI 啦●'◡'●），然后问问豆包如果遇到彩色图，不想损失太多信息，该怎么办？

AI 就是这样用的嘛，对吧，用 AI 满足自己的好奇心和探索欲望。与其说是满足，其实更多的是对好奇心的“保护”，当你发现你有一个永远耐心和鼓励你的老师，探索未知就不再那么恐怖。能确信知识唾手可得，只是等着你去问，这种安全感太棒了！

无论是任何领域，专业课或者计算机科学之外，希望大家能保持探索未知的勇气和决心，做自己热爱的事情。不要怀疑自己的能力，你已经做得很好了，就是缺一点点时间成长。

### 什么是 SSIM

回到主题。我们现在有一张没有经过滤波的原图，和一张经过滤波的图片，我们怎么知道滤波的效果就更好呢？放心，过去的计算机科学家想出来一套办法，用来衡量我们滤波的效果。

不过在衡量效果之前，我们需要一套标准，我们需要知道没有噪点的图片是什么样的，也就是原图。然后再给没噪点的图片人工加入噪点。通过我们的滤波处理，看看处理后的照片是在原图与噪点图之间，还是距离原图更远了？

先放个总公式：

$$
\mathrm{SSIM}(x, y)
= \frac{(2\mu_x \mu_y + C_1)(2\sigma_{xy} + C_2)}
       {(\mu_x^2 + \mu_y^2 + C_1)(\sigma_x^2 + \sigma_y^2 + C_2)}
$$

是不是很吓人？
其中：

- $\mu_x, \mu_y$ ：两张图的全局（或局部）平均值（亮度）
- $\sigma_x^2, \sigma_y^2$ ：两张图的全局（或局部）方差（`var_x` 和 `var_y`）
- $\sigma_{xy}$ ：两张图对应像素的协方差（`cov_xy`）
- $C_1, C_2$ ：稳定常数（防止分母为 0），常用 $C_1 = (0.01 \times 255)^2 \approx 6.5025$ ， $C_2 = (0.03 \times 255)^2 \approx 58.5225$ （8-bit 图像）

这样讲看不懂太正常了！听我娓娓道来，再回头看这个公式就好。

### 最关键的是方差和协方差

什么是方差？方差决定了一串数据的值有多乱？乱就是数据之间值的差距大的意思。

我们这里像素只有单通道的灰度值，灰度一般就是反映图片亮度差异的。大家应该听说过 HDR 照片，还有拍视频的 log 格式，还有灰片吧？所以就是方差大 → 数字波动很大（像素亮暗差别很大）；方差小 → 数字很集中（图像很平、对比度低）。大家可以使用相册的编辑功能，拉动对比度，体会一下“方差”对图片的影响。

注：这里我们计算方差除以的是 N 而不是统计学里算样本方差的 N-1，因为在图像处理里，我们通常把这一块像素看作总体，或者为了简化计算直接使用 N，这在工程上是标准做法哦。

什么是协方差？协方差就是衡量两串数据之间的关系。

- 协方差 > 0 → 两张图像素“同涨同跌”（结构很相似）
- 协方差 ≈ 0 → 两张图几乎没关系
- 协方差 < 0 → 两张图“此消彼长”（结构相反）

最后，所有像素点的平均值，就是整张图整体亮度的体现，平均值越大，图片整体就越亮。

### SSIM 的三个分量

如果说一张图片的平均值能反映图像整体亮度，方差能反映对比度，协方差是结构相似性。
那么可以用三个式子表示：

亮度比较（luminance）：

$$
l(x, y) = \frac{2\mu_x \mu_y + C_1}{\mu_x^2 + \mu_y^2 + C_1}
$$

对比度比较（contrast）：

$$
c(x, y) = \frac{2\sigma_x \sigma_y + C_2}{\sigma_x^2 + \sigma_y^2 + C_2}
$$

结构比较（structure）：

$$
s(x, y) = \frac{\sigma_{xy} + C_3}{\sigma_x \sigma_y + C_3}
$$

把上面三个式子直接相乘（ $\alpha = \beta = \gamma = 1$ ），再把 $C_3 = C_2 / 2$ 代入，分子和分母分别合并，就得到化简后的公式：

$$
\mathrm{SSIM}(x, y)
= \frac{(2\mu_x \mu_y + C_1)(2\sigma_{xy} + C_2)}
       {(\mu_x^2 + \mu_y^2 + C_1)(\sigma_x^2 + \sigma_y^2 + C_2)}
$$

至于怎么计算方差。

先算平均值 $\mu_x$ （`mean_x`）：

$$
\mu_x = \frac{1}{N} \sum_{i=1}^{N} x_i
$$

再算方差 $\sigma_x^2$ （`var_x`）：

$$
\sigma_x^2 = \frac{1}{N} \sum_{i=1}^{N} (x_i - \mu_x)^2
$$

协方差就是先分别算两个平均值：

$$
\mu_x = \frac{1}{N} \sum_{i=1}^{N} x_i,\qquad
\mu_y = \frac{1}{N} \sum_{i=1}^{N} y_i
$$

再算协方差 $\sigma_{xy}$ （`cov_xy`）：

$$
\sigma_{xy} = \frac{1}{N} \sum_{i=1}^{N} (x_i - \mu_x)(y_i - \mu_y)
$$

### 放回代码里看

在 ch2 的实验中，我们已经提供好了 SSIM 的整体框架和主要变量，大家需要根据文档中的公式，自己完成均值、方差、协方差的计算，以及最后的 SSIM 结果计算。

只用关注 `metrics_compute_ssim()` 和 `TODO` 部分，别的代码不是强制要求去读，感兴趣可以看看。

当然，我们实验的 SSIM 是简化版本，工业上把窗口做成高斯核或均匀核，一次性算出全图的局部 `mean`、`var`、`cov`，速度能快非常多。

现在，你应该看得懂 `output/ch2/metrics.csv` 在说什么了吧？我们将加过噪点的图片，和原图做一次 SSIM 计算，然后再将被处理过的“加了噪点的图片”和原图做一次 SSIM 计算。对比这两个 SSIM 的值。

SSIM 的理论范围是 $[-1, 1]$ 。
但在自然图像（灰度或彩色）中，实际取值几乎总是 $[0, 1]$ 。

- `1`：两张图像完全相同（完美匹配）。
- 接近 `0`：两张图像结构差异极大（几乎没有相似之处）。
- 负值极少出现，特意构造对比度或结构完全相反时才可能出现。

### 为什么 SSIM = 1 时是“最好”？

回忆 SSIM 的不化简前原始公式（三个分量相乘）：

$$
\mathrm{SSIM}(x, y) = l(x, y) \cdot c(x, y) \cdot s(x, y)
$$

其中：

- 亮度分量： $l(x, y) = \frac{2\mu_x \mu_y + C_1}{\mu_x^2 + \mu_y^2 + C_1}$ 
- 对比度分量： $c(x, y) = \frac{2\sigma_x \sigma_y + C_2}{\sigma_x^2 + \sigma_y^2 + C_2}$ 
- 结构分量： $s(x, y) = \frac{\sigma_{xy} + C_3}{\sigma_x \sigma_y + C_3}$ 

当两张图像完全一样（即 $x = y$ ）时：

- $\mu_x = \mu_y$ → $l(x, y) = 1$ 
- $\sigma_x = \sigma_y$ 且 $\sigma_{xy} = \sigma_x^2$ → $c(x, y) = 1$ 、 $s(x, y) = 1$ 

因此三个分量都等于 $1$ ，相乘后：

$$
\mathrm{SSIM} = 1 \times 1 \times 1 = 1
$$

当图像差异越大时：

- 亮度差越大 → $l$ 越小
- 对比度差越大 → $c$ 越小
- 结构越不一致（协方差 $\sigma_{xy}$ 越小） → $s$ 越小

所以 SSIM 整体就会越小。

完成 ch2 后运行，看看 `output/ch2/metrics.csv` 的结果吧！

感兴趣也可以尝试另一种不同于 SSIM 的衡量方法，也就是 `output/ch2/metrics.csv` 中的 PSNR 这一项. 我们的代码框架实现了一个精简后，全局计算版的 PSNR，可以试试借助 `豆包` 等 AI 辅助工具，配合框架代码，独立学习相关概念。文档在此不过多赘述。
