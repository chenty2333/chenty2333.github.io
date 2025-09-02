# 🚀 Terminal-Style Notes Website

一个模拟 Linux 终端操作的个人笔记网站，托管在 GitHub Pages 上。通过终端命令浏览和阅读 Markdown/HTML 笔记，享受独特的"黑客风格"阅读体验。

## ✨ 特色功能

- 🖥️ **真实终端体验**：完整的命令行界面，支持 `ls`、`cd`、`tree`、`read` 等命令
- 🧩 **� 模块化架构**：命令系统完全模块化，轻松扩展新功能
- �🎨 **多主题支持**：retro（复古绿）、amber（琥珀色）、modern（现代灰白）+ 智能明暗模式
- 📚 **高质量渲染**：GitHub 风格 Markdown + 优雅语法高亮
- 💾 **配置持久化**：别名、环境变量、主题设置永久保存
- 🔍 **智能搜索**：支持文件名和内容搜索
- ⚡ **Tab 补全**：命令和路径自动补全
- 📱 **响应式设计**：适配各种设备尺寸，移动端完美体验

## 🎯 在线体验

**🌐 访问地址：[https://chenty2333.github.io](https://chenty2333.github.io)**

## 📖 快速开始

### 基本命令
```bash
help                    # 查看所有命令
ls -la                  # 列出目录内容
cd notes               # 进入目录
tree                   # 显示目录树
read readme.md         # 阅读文档
config                 # 查看配置
```

### 个性化设置
```bash
export PS1="➜ "        # 自定义提示符
export THEME=amber     # 切换主题
alias ll="ls -la"      # 设置别名
config                 # 查看所有配置
```

## 🛠️ 本地开发

### 预览网站
建议使用静态服务器在项目根目录启动服务：

```bash
# 使用 VS Code Live Server 扩展 (推荐)
# 或者使用 Python
python -m http.server 8000

# 或者使用 Node.js
npx serve .
```

### 更新文件索引
当添加新的笔记文件后，运行构建脚本更新虚拟文件系统：

```bash
node scripts/build-fs.js
```

## 📁 项目结构

```
Terminal-Style Notes/
├── index.html              # 主页（终端界面）
├── reader.html             # 文章阅读页面
├── terminal.js             # 终端核心逻辑和引擎
├── style.css               # 终端样式和主题
├── commands/               # 🆕 模块化命令系统
│   ├── index.js            #   命令注册中心
│   ├── base.js             #   基础命令 (help, clear, echo)
│   ├── file.js             #   文件操作 (ls, cd, pwd, tree, read)
│   ├── search.js           #   搜索功能 (grep)
│   └── config.js           #   配置管理 (alias, export, config)
├── parser/
│   ├── markdown.css        # Markdown 渲染样式
│   └── html.css            # HTML 文档样式
├── notes/                  # 笔记存放目录
│   ├── readme.md           # 详细使用指南
│   └── ...                 # 你的笔记文件
├── data/
│   └── fs.json             # 虚拟文件系统索引
└── scripts/
    └── build-fs.js         # 文件索引构建脚本
```

## 🎮 高级功能

### Bashrc 支持
完整的类 bash 配置系统：
- ✅ **永久别名**：`alias ll="ls -la"`
- ✅ **环境变量**：`export THEME=amber`
- ✅ **命令历史**：上下箭头浏览历史
- ✅ **Tab 补全**：智能命令和路径补全

### 配置管理
```bash
config show            # 查看所有配置
config reset env       # 重置环境变量
config reset alias     # 清除别名
config reset all       # 重置所有配置
```

### 搜索功能
```bash
grep "关键词"          # 搜索文件名
grep "内容" --content  # 搜索文件内容
```

## 🎨 主题展示

| 主题 | 描述 | 适用场景 |
|------|------|----------|
| `retro` | 经典绿色终端 | 怀旧复古风格 |
| `amber` | 温暖琥珀色调 | 长时间阅读护眼 |
| `modern` | 现代灰白配色 | 简洁专业风格 |

## 📝 使用场景

- 📖 **个人知识库**：技术笔记、学习资料整理
- 👥 **团队文档**：API 文档、最佳实践分享  
- 🎓 **教学演示**：终端操作教学、技术分享
- ✍️ **创意写作**：小说章节、博客草稿管理

## 🔧 技术栈

- **前端**：原生 HTML + CSS + JavaScript
- **架构**：🆕 模块化命令系统，支持动态扩展
- **部署**：GitHub Pages（零配置静态托管）
- **渲染**：marked.js（Markdown）+ Prism.js（代码高亮）
- **存储**：localStorage + sessionStorage（配置持久化）

## 🛠️ 开发者指南

### 添加新命令
现在添加新命令变得非常简单！

1. **创建命令文件**（如 `commands/network.js`）：
```javascript
(function() {
  const networkCommands = {
    ping: {
      help: 'ping 网络测试',
      run(args, { println }) {
        println('PONG! ' + (args[0] || 'localhost'));
      }
    },
    
    status: {
      help: '检查网络状态',
      run(args, { println }) {
        println('🌐 网络连接正常');
      }
    }
  };
  
  // 自动注册到命令系统
  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(networkCommands);
  }
})();
```

2. **在 index.html 中引入**：
```html
<script src="./commands/network.js"></script>
```

3. **完成！** 新命令立即可用，支持 Tab 补全和帮助系统

### 命令开发 API
每个命令的 `run` 函数接收两个参数：
- `args`：命令参数数组
- `context`：包含所有可用函数和数据的上下文对象

**可用的 context 方法**：
```javascript
{
  // 输出函数
  println,          // 打印文本行
  printHTML,        // 打印 HTML 内容
  output,           // 输出容器元素
  
  // 文件系统
  normalizePath,    // 标准化路径
  getNode,          // 获取文件/目录节点
  isDir, isFile,    // 类型检查
  listDir, tree,    // 目录操作
  
  // 状态管理
  env,              // 环境变量
  aliasMap,         // 别名映射
  cwd, setCwd,      // 当前目录
  
  // 配置和存储
  saveJSON,         // 保存 JSON 数据
  LS_KEYS,          // localStorage 键名
  
  // UI 控制
  applyTheme,       // 应用主题
  renderPrompt,     // 更新提示符
}
```

## 🚀 部署指南

1. **Fork 或 Clone 此仓库**
2. **添加你的笔记**到 `notes/` 目录
3. **运行构建脚本**：`node scripts/build-fs.js`
4. **（可选）添加自定义命令**到 `commands/` 目录
5. **提交到 GitHub**
6. **启用 GitHub Pages**（Settings → Pages → Source: Deploy from a branch → main）

### 开发者部署
如果你想扩展功能或贡献代码：

```bash
# 克隆仓库
git clone https://github.com/chenty2333/chenty2333.github.io.git
cd chenty2333.github.io

# 启动本地服务器
python -m http.server 8000
# 或使用 VS Code Live Server

# 添加新命令模块
touch commands/my-commands.js
# 编辑命令实现

# 更新文件索引
node scripts/build-fs.js

# 测试和部署
git add .
git commit -m "Add new commands"
git push
```

## 📚 详细文档

访问网站后执行 `read readme.md` 查看完整的使用指南，包含：
- 🔧 所有命令的详细说明
- 💡 实用技巧和最佳实践
- ⚙️ 高级配置和自定义
- 🐛 故障排除和性能优化

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License

---

**💡 开始探索**：[https://chenty2333.github.io](https://chenty2333.github.io)

*享受你的 Terminal Notes 之旅！🎉*