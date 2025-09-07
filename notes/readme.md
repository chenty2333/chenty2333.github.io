# 🚀 Terminal Notes 使用指南

欢迎来到 **Terminal Notes** - 一个模拟 Linux 终端操作的个人笔记网站！

## 📖 项目简介

这是一个托管在 GitHub Pages 上的静态网站，通过终端命令的方式浏览和管理你的笔记。你可以像在真实的 Linux 终端中一样，使用 `ls`、`cd`、`tree`、`read` 等命令来操作文件系统，阅读 Markdown 和 HTML 格式的笔记。

> ✨ **设计理念**：将传统的文件浏览体验与现代 Web 技术结合，创造独特的"黑客风格"笔记阅读体验。

---

## 🎯 快速开始

### 基本操作

```bash
# 查看当前目录内容
ls

# 详细列表显示
ls -l

# 显示隐藏文件
ls -a

# 进入目录
cd linux

# 返回上级目录
cd ..

# 回到根目录
cd ~

# 显示当前路径
pwd

# 树形显示目录结构
tree

# 阅读文章
read demo.md

# 在新窗口打开文章（方便分享）
read demo.md --new
```

### 获取帮助

```bash
# 显示所有可用命令
help

# 清空终端输出
clear

# 打印文本
echo "Hello Terminal Notes!"

# 查看和管理所有配置
config
```

---

## 🔧 高级功能

### 1. 别名系统 (Alias)

像真正的 bash 一样，你可以设置命令别名来提高效率：

```bash
# 设置别名
alias ll="ls -la"
alias tree="tree"
alias vim="read"

# 查看所有已设置的别名
alias

# 使用别名
ll  # 等同于 ls -la
```

**特点：**
- ✅ 别名会**永久保存**，重启浏览器后仍然有效
- ✅ 支持参数传递和复杂命令组合
- ✅ 自动展开，就像真正的 bash 别名

### 2. 环境变量 (Environment Variables)

通过 `export` 命令自定义终端环境：

```bash
# 自定义命令提示符
export PS1="> "          # 简洁风格
export PS1="λ "          # Lambda 符号
export PS1="➜ "          # 箭头符号

# 切换主题
export THEME=retro       # 复古绿色主题（默认）
export THEME=amber       # 琥珀色主题
export THEME=modern      # 现代灰白主题

# 调整字体大小
export FONTSIZE=18       # 设置字体大小为 18px
export FONTSIZE=14       # 更小的字体

# 设置输出行数限制
export OUTPUT_MAX=120    # 最多保留 120 行输出

# 查看所有环境变量
export
```

**特点：**
- ✅ 所有环境变量**永久保存**
- ✅ 立即生效，无需重启
- ✅ 支持数字和字符串类型自动识别

### 3. 主题系统

内置三种精心设计的主题：

| 主题 | 描述 | 使用场景 |
|------|------|----------|
| `retro` | 经典绿色终端风格 | 喜欢复古黑客风格 |
| `amber` | 温暖的琥珀色调 | 长时间阅读，护眼舒适 |
| `modern` | 现代灰白配色 | 简洁现代，适合正式场合 |

```bash
# 快速切换主题
export THEME=amber
export THEME=modern
export THEME=retro
```

### 4. 智能补全

支持两种类型的 Tab 补全：

**命令补全：**
```bash
tre[Tab]  # 自动补全为 tree
ech[Tab]  # 自动补全为 echo
```

**路径补全：**
```bash
cd li[Tab]     # 补全为 cd linux/
read lin[Tab]  # 补全为 read linux/
```

**特点：**
- ✅ 支持命令名和别名补全
- ✅ 智能路径补全，自动识别目录和文件
- ✅ 多个候选项时显示所有可能选项

### 5. 命令历史

```bash
# 使用上下箭头键浏览命令历史
↑  # 上一条命令
↓  # 下一条命令
```

**特点：**
- ✅ 自动记录所有执行的命令
- ✅ 会话内保持，刷新页面不丢失
- ✅ 支持快速重复执行常用命令

### 6. 搜索功能 (grep)

强大的文件搜索功能：

```bash
# 按文件名搜索
grep demo

# 在指定目录搜索
grep linux linux/

# 搜索文件内容（会实际读取文件）
grep "算法" --content

# 在指定路径搜索内容
grep "JavaScript" linux/ --content
```

**特点：**
- ✅ 支持文件名模糊搜索
- ✅ 支持文件内容全文搜索
- ✅ 自动限制搜索范围，避免性能问题
- ✅ 智能排序和结果分类

### 7. 配置管理 (config)

全新的配置管理命令，让你轻松查看和管理所有终端设置：

```bash
# 查看所有当前配置
config
# 或者
config show

# 重置环境变量为默认值
config reset env

# 清除所有别名
config reset alias

# 重置所有配置（环境变量+别名）
config reset all
```

**config 命令显示的信息：**
- 📊 **配置概览**：清晰的分类显示
- 🔧 **环境变量**：显示值和是否为默认设置
- 📛 **命令别名**：所有自定义别名列表
- 💾 **存储说明**：提醒数据持久化机制
- 💡 **使用示例**：常用配置的快速参考

**特点：**
- ✅ 一键查看所有配置状态
- ✅ 区分默认值和自定义值
- ✅ 支持选择性重置配置
- ✅ 提供配置使用指导

---

## 📚 文章阅读体验

### 阅读模式

```bash
# 在当前窗口打开文章
read demo.md

# 在新窗口打开（方便分享链接）
read demo.md --new
```

### 文章页面功能

当你打开一篇文章时，你会看到：

- **🌓 明暗模式切换**：右上角的模式切换按钮
- **>_ Terminal 按钮**：点击返回终端，自动进入文章所在目录
- **📍 路径显示**：清晰显示当前文章位置
- **🎨 Typora 风格渲染**：高质量的 Markdown 渲染效果

### 支持的文件格式

- **Markdown (.md)**：完整的 GitHub 风格渲染
- **HTML (.html)**：原生 HTML 文件支持
- **代码高亮**：支持多种编程语言语法高亮

---

## 💾 数据持久化

### 永久保存的数据

以下配置会永久保存在浏览器的 localStorage 中：

- ✅ **别名设置** (`alias`)
- ✅ **环境变量** (`export`)
- ✅ **主题选择** (明暗模式)
- ✅ **自定义提示符** (`PS1`)
- ✅ **字体大小** (`FONTSIZE`)

**重启浏览器后这些设置依然有效！**

### 会话级数据

以下数据只在当前会话中保存：

- 🔄 **当前工作目录** (`cwd`)
- 🔄 **终端输出历史**
- 🔄 **命令执行历史**

**重启浏览器后会重置为默认状态。**

---

## 🎨 界面定制

### 个性化提示符

```bash
# 经典样式
export PS1="$ "

# 现代简洁
export PS1="> "

# 有趣符号
export PS1="λ "      # Lambda
export PS1="➜ "      # 箭头
export PS1="❯ "      # 角括号
export PS1="⚡ "      # 闪电

# 带颜色（需要主题支持）
export PS1="~/> "    # 显示路径
```

### 字体大小调节

```bash
# 适合不同屏幕和使用场景
export FONTSIZE=12   # 紧凑模式
export FONTSIZE=16   # 默认大小
export FONTSIZE=20   # 大字体模式
export FONTSIZE=24   # 演示模式
```

### 输出控制

```bash
# 控制终端保留的历史行数
export OUTPUT_MAX=50    # 精简模式
export OUTPUT_MAX=100   # 标准模式
export OUTPUT_MAX=200   # 详细模式
```

---

## 🔍 实用技巧

### 1. 快速导航

```bash
# 使用别名提高效率
alias ..="cd .."
alias ...="cd ../.."
alias home="cd ~"

# 设置常用目录别名
alias notes="cd ~"
alias linux="cd linux"
alias docs="cd documents"
```

### 2. 批量操作

```bash
# 快速浏览目录结构
tree

# 搜索相关文章
grep "教程"
grep "tutorial" --content

# 清理终端保持清爽
clear
```

### 3. 工作流优化

```bash
# 设置个人偏好
export PS1="⚡ "
export THEME=amber
export FONTSIZE=18
alias ll="ls -la"
alias edit="read"

# 保存常用命令
alias status="pwd && ls -la"
alias search="grep"
```

### 4. 配置管理技巧

```bash
# 定期检查配置状态
config

# 配置备份策略（手动记录重要配置）
echo "我的常用配置:" > my-config.txt
# 然后手动记录 export 和 alias 命令

# 测试新配置前先查看当前配置
config
export THEME=modern  # 测试新主题
# 如果不喜欢可以重置
config reset env

# 分步重置（只重置特定部分）
config reset alias   # 只清除别名，保留环境变量
config reset env     # 只重置环境变量，保留别名
```

---

## 🚀 高级用法

### 1. 命令组合

```bash
# 虽然不支持管道，但可以通过别名实现复杂操作
alias explore="pwd && echo '---' && ls -la && echo '---' && tree"
```

### 2. 工作区切换

```bash
# 快速跳转到不同的笔记分类
alias dev="cd development"
alias study="cd learning"
alias project="cd projects"
```

### 3. 搜索策略

```bash
# 分层搜索
grep "React" frontend/
grep "Python" backend/
grep "算法" algorithms/ --content
```

---

## 🔧 故障排除

### 常见问题

**Q: 为什么文件加载失败？**
A: 请确保通过 HTTP/HTTPS 访问，不要使用 `file://` 协议。

**Q: 我的别名设置丢失了？**
A: 检查浏览器是否禁用了 localStorage，或清理了网站数据。

**Q: 命令补全不工作？**
A: 确保按 Tab 键而不是空格，并检查输入的命令前缀是否正确。

**Q: 主题切换没有效果？**
A: 尝试刷新页面，或检查 `export THEME=` 命令是否正确执行。

### 性能优化建议

```bash
# 定期清理输出历史
clear

# 限制输出行数
export OUTPUT_MAX=80

# 使用精确的搜索条件
grep "specific-term" target-directory/
```

---

## 🚀 开始你的Terminal Notes之旅

现在你已经了解了所有功能，开始定制属于你的终端环境吧！

```bash
# 第一步：设置个人偏好
export PS1="➜ "
export THEME=amber
export FONTSIZE=16

# 第二步：创建常用别名
alias ll="ls -la"
alias docs="cd documents"
alias search="grep"

# 第三步：探索你的笔记
tree
ls -la
read readme.md

# 第四步：查看你的配置
config

# 开始你的探索之旅！
help
```

---

**🌐 访问地址**：[https://chenty2333.github.io](https://chenty2333.github.io)

---

*Happy Terminal Hacking! 🎉*
