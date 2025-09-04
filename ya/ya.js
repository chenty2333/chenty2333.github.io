/**
 * ya 文件浏览器 - 主逻辑
 * 独立实现，可复用原有项目的功能
 */

class YaExplorer {
    constructor() {
        this.fsData = null;
        this.currentPath = 'notes';
        this.selectedIndex = 0;
        this.focusedPanel = 'center'; // left, center, right
        this.modeKey = 'ya_mode';
        
        // 搜索相关属性
        this.searchQuery = '';
        this.searchActive = false;
        this.searchTimeout = null;
        
        // 性能监控
        this.performanceMonitor = {
            renderCount: 0,
            lastRenderTime: 0,
            totalRenderTime: 0
        };
        
        // 面板状态
        this.panels = {
            left: { path: '', files: [], selectedIndex: 0 },
            center: { path: 'notes', files: [], selectedIndex: 0 },
            right: { path: '', content: null, type: 'empty' }
        };
        
        this.init();
    }
    
    async init() {
        try {
            await this.loadFileSystem();
            this.setupEventListeners();
            this.parseUrlParams();
            await this.updateAllPanels();
            this.render();
            this.focusCenter();
            this.applyModeToPreview();
        } catch (error) {
            // 统一错误处理
            this.handleError('初始化失败', error);
            
            // 显示错误信息给用户
            const centerList = document.getElementById('centerList');
            if (centerList) {
                centerList.innerHTML = `
                    <div style="padding: 20px; color: #ff6b6b; text-align: center;">
                        <h3>初始化错误</h3>
                        <p>${error.message}</p>
                        <p><small>请刷新页面重试</small></p>
                    </div>
                `;
            }
        }
    }
    
    // 加载文件系统数据 - 改进错误处理
    async loadFileSystem() {
        try {
            const response = await fetch('../data/fs.json');
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            this.fsData = await response.json();
            
            // 验证数据结构
            if (!this.fsData || typeof this.fsData !== 'object') {
                throw new Error('文件系统数据格式无效');
            }
            
        } catch (error) {
            // 统一错误处理
            this.handleError('文件系统加载失败', error);
            throw error; // 重新抛出以阻止应用初始化
        }
    }
    
    // 解析URL参数，支持从终端传递初始路径
    parseUrlParams() {
        try {
            const params = new URLSearchParams(window.location.search);
            const path = params.get('path');
            
            if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                console.log('URL path parameter:', path);
            }
            
            if (path && this.pathExists(path)) {
                this.currentPath = this.normalizePath(path);
                this.panels.center.path = this.currentPath;
                
                if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                    console.log('Set current path to:', this.currentPath);
                }
            } else {
                if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                    console.log('Using default path: notes');
                }
            }
        } catch (error) {
            this.handleError('URL参数解析失败', error);
        }
    }
    
    // 路径处理工具函数 - 修复版本
    normalizePath(pathStr) {
        if (!pathStr) return this.currentPath || 'notes';
        let p = pathStr.trim();

        // ~ 映射到 notes 根目录
        if (p.startsWith('~')) {
            p = 'notes' + p.slice(1);
        }

        // 处理绝对路径（以 / 开头）
        if (p.startsWith('/')) {
            p = p.replace(/^\/+/, ''); // 移除开头的斜杠
        } else if (!p.startsWith('notes')) {
            // 非以 notes 开头的视为相对路径
            if (this.currentPath) {
                p = this.currentPath + '/' + p;
            } else {
                p = 'notes/' + p;
            }
        }

        // 标准化路径（处理 . 和 ..）
        const parts = p.split('/').filter(part => part && part !== '.');
        const normalized = [];

        for (const part of parts) {
            if (part === '..') {
                normalized.pop();
            } else {
                normalized.push(part);
            }
        }

        return normalized.join('/') || 'notes';
    }
    
    // 获取节点 - 复用原项目逻辑
    getNode(pathStr) {
        const parts = this.normalizePath(pathStr).split('/').filter(Boolean);
        let node = this.fsData;
        for (const p of parts) {
            if (!node || !node[p]) return undefined;
            node = node[p];
        }
        return node;
    }
    
    // 检查路径是否存在
    pathExists(pathStr) {
        return !!this.getNode(pathStr);
    }
    
    // 判断是否为目录
    isDir(node) {
        return node && typeof node === 'object' && !node.type;
    }
    
    // 判断是否为文件
    isFile(node) {
        return node && typeof node === 'object' && node.type === 'file';
    }
    
    // 获取目录下的文件列表
    getFileList(pathStr, searchQuery = '') {
        const node = this.getNode(pathStr);
        if (!this.isDir(node)) return [];
        
        let files = Object.keys(node)
            .filter(name => !name.startsWith('.')) // 过滤隐藏文件
            .map(name => {
                const child = node[name];
                const fullPath = pathStr + '/' + name;
                
                return {
                    name,
                    path: fullPath,
                    isDir: this.isDir(child),
                    isFile: this.isFile(child),
                    size: child.size || 0,
                    mtime: child.mtime || '',
                    type: this.getFileType(name)
                };
            });
        
        // 为非根目录添加".."返回项
        if (pathStr && pathStr !== 'notes') {
            const parentPath = this.getParentPath(pathStr);
            files.unshift({
                name: '..',
                path: parentPath || 'notes',
                isDir: true,
                isFile: false,
                size: 0,
                mtime: '',
                type: 'parent'
            });
        }
        
        // 搜索过滤 (不对".."项进行搜索过滤)
        if (searchQuery && this.fuse) {
            const results = this.fuse.search(searchQuery);
            const matchedNames = new Set(results.map(r => r.item.name));
            // 保留".."项和匹配的项
            files = files.filter(f => f.name === '..' || matchedNames.has(f.name));
        }
        
        // 排序：".."在最前，然后目录在前，文件在后，按名称排序
        files.sort((a, b) => {
            if (a.name === '..') return -1;
            if (b.name === '..') return 1;
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            return a.name.localeCompare(b.name, 'zh-Hans-CN');
        });
        
        return files;
    }
    
    // 获取文件类型
    getFileType(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        const typeMap = {
            'md': 'md',
            'txt': 'file',
            'js': 'code',
            'ts': 'code',
            'html': 'code',
            'css': 'code',
            'json': 'code',
            'png': 'image',
            'jpg': 'image',
            'jpeg': 'image',
            'gif': 'image',
            'svg': 'image'
        };
        return typeMap[ext] || 'file';
    }
    
    // 更新所有面板
    async updateAllPanels() {
        await this.updateCenterPanel();
        await this.updateLeftPanel();
        await this.updateRightPanel();
        this.updateSearchIndex();
    }
    
    // 更新中间面板（当前目录）
    async updateCenterPanel() {
        this.panels.center.path = this.currentPath;
        this.panels.center.files = this.getFileList(this.currentPath, this.searchQuery);
        
        // 确保选中索引有效
        const maxIndex = Math.max(0, this.panels.center.files.length - 1);
        this.panels.center.selectedIndex = Math.min(this.panels.center.selectedIndex, maxIndex);
    }
    
    // 更新左侧面板（上级目录）
    async updateLeftPanel() {
        const parentPath = this.getParentPath(this.currentPath);
        if (parentPath) {
            this.panels.left.path = parentPath;
            this.panels.left.files = this.getFileList(parentPath);
            
            // 在父目录中高亮当前目录
            const currentDirName = this.currentPath.split('/').pop();
            const currentIndex = this.panels.left.files.findIndex(f => f.name === currentDirName);
            this.panels.left.selectedIndex = Math.max(0, currentIndex);
        } else {
            this.panels.left.files = [];
        }
    }
    
    // 更新右侧预览面板 - 重写版本，支持所有面板的预览
    async updateRightPanel() {
        const selectedFile = this.getSelectedFile();
        if (!selectedFile || selectedFile.name === '..') {
            this.panels.right.content = '';
            this.panels.right.type = 'empty';
            return;
        }
        
        if (selectedFile.isDir) {
            // 预览目录内容
            this.panels.right.files = this.getFileList(selectedFile.path);
            this.panels.right.type = 'directory';
            this.panels.right.content = '';
        } else {
            // 预览文件内容
            this.showPreviewLoading();
            
            try {
                const content = await this.loadFileContentOptimized(selectedFile.path);
                this.panels.right.content = content;
                this.panels.right.type = selectedFile.type;
                this.renderRightPanel(); // 立即渲染更新
            } catch (error) {
                this.panels.right.content = '预览失败: ' + error.message;
                this.panels.right.type = 'error';
                this.renderRightPanel(); // 立即渲染错误
                this.handleError('文件预览失败', error);
            }
        }
    }
    
    // 显示预览加载状态
    showPreviewLoading() {
        this.panels.right.type = 'loading';
        this.panels.right.content = '正在加载...';
        this.renderRightPanel(); // 立即显示加载状态
    }
    
    // 优化的文件加载方法
    async loadFileContentOptimized(path) {
        // 创建AbortController用于超时控制
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // 3秒超时
        
        try {
            const response = await fetch('../' + path, {
                signal: controller.signal,
                headers: {
                    'Cache-Control': 'no-cache' // 避免缓存问题
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            // 检查Content-Type以优化处理
            const contentType = response.headers.get('content-type') || '';
            const isText = contentType.includes('text/') || 
                          contentType.includes('application/json') ||
                          path.match(/\.(md|txt|js|ts|html|css|json|xml|yaml|yml)$/i);
            
            if (!isText) {
                return `二进制文件，无法预览\n文件类型: ${contentType || '未知'}`;
            }
            
            // 使用流式读取，支持大文件的分块加载
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let content = '';
            let totalBytes = 0;
            const maxBytes = 100 * 1024; // 最大100KB
            
            while (totalBytes < maxBytes) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const chunk = decoder.decode(value, { stream: true });
                content += chunk;
                totalBytes += value.length;
                
                // 对于大文件，每读取一些内容就检查是否超出限制
                if (totalBytes > maxBytes) {
                    content += '\n\n... (文件过大，已截断显示)';
                    break;
                }
            }
            
            // 完成剩余的解码
            content += decoder.decode();
            
            return content;
            
        } catch (error) {
            // 统一错误处理
            this.handleError('文件加载失败', error, true);
            throw new Error(`加载失败: ${error.message}`);
        } finally {
            clearTimeout(timeoutId);
        }
    }
    
    // 获取父级路径
    getParentPath(path) {
        if (!path || path === 'notes') return null;
        const parts = path.split('/');
        parts.pop();
        return parts.join('/') || 'notes';
    }
    
    // 获取当前选中的文件
    getSelectedFile() {
        const panel = this.panels[this.focusedPanel];
        if (!panel || !panel.files || panel.files.length === 0 || 
            panel.selectedIndex < 0 || panel.selectedIndex >= panel.files.length) {
            return null;
        }
        return panel.files[panel.selectedIndex];
    }
    
    // 更新搜索索引
    updateSearchIndex() {
        if (window.Fuse && this.panels.center.files.length > 0) {
            this.fuse = new Fuse(this.panels.center.files, {
                keys: ['name'],
                threshold: 0.4,
                includeScore: true
            });
        }
    }
    
    // 设置事件监听器
    setupEventListeners() {
        // 返回按钮
        const backBtn = document.getElementById('backBtn');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                const from = this.currentPath || 'notes';
                // 与 reader 的 Terminal 按钮一致：直接回到 index.html 并携带 path
                window.location.href = `../index.html?path=${encodeURIComponent(from)}`;
            });
        }
        
        // 搜索输入 - 防抖处理
    const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                clearTimeout(this.searchTimeout);
                this.searchTimeout = setTimeout(() => {
            this.searchQuery = e.target.value;
            // 有内容即进入搜索态（但是否退出由 Backspace 额外一次控制）
            this.searchActive = this.searchQuery.length > 0;
                    this.updateCenterPanel();
                    this.render();
                }, 150); // 150ms防抖
            });
        }
        
        // 键盘事件 - 使用 hotkeys.js 管理
        if (window.hotkeys) {
            this.setupHotkeys();
        } else {
            console.warn('hotkeys.js 未加载，键盘快捷键将不可用');
        }
        
        // 鼠标点击事件
        this.setupMouseEvents();
        
        // 窗口大小改变时重新渲染
        window.addEventListener('resize', () => {
            this.render();
        });

        // 监听 YA 自身主题变更
        window.addEventListener('storage', (ev) => {
            if (ev.key === this.modeKey && ev.newValue) {
                const isLight = ev.newValue === 'mode-light';
                document.documentElement.classList.toggle('mode-light', isLight);
                document.documentElement.classList.toggle('mode-dark', !isLight);
                this.applyModeToPreview();
            }
        });
    }
    
    // 设置热键 - 使用 hotkeys.js
    setupHotkeys() {
        // 默认情况下，hotkeys.js 在 INPUT, SELECT, TEXTAREA 元素上不生效
        // 我们需要手动启用它
        hotkeys.filter = function(event) {
            return true;
        };

        // 导航键（模仿yazi的逻辑）
        hotkeys('h,left', { element: document }, (e) => { 
            if (e.target.id !== 'searchInput') {
                e.preventDefault(); this.navigateLeft(); 
            }
        });
        hotkeys('j,down', { element: document }, (e) => { 
            if (e.target.id !== 'searchInput') {
                e.preventDefault(); this.moveDown(); 
            }
        });
        hotkeys('k,up', { element: document }, (e) => { 
            if (e.target.id !== 'searchInput') {
                e.preventDefault(); this.moveUp(); 
            }
        });
        hotkeys('l,right', { element: document }, (e) => { 
            if (e.target.id !== 'searchInput') {
                e.preventDefault(); this.navigateRight(); 
            }
        });

        // 功能键
        hotkeys('enter', { element: document }, (e) => {
            e.preventDefault();
            if (e.target.id === 'searchInput') {
                // 搜索框回车：进入“选择模式”，不直接打开
                e.target.blur();
                this.searchActive = true;
                if (this.panels.center.files.length > 0) {
                    this.panels.center.selectedIndex = 0; // 选中第一个
                    this.updateRightPanel();
                    this.render();
                }
            } else {
                this.openSelected();
            }
        });

        // 选择模式下的退格：编辑搜索词；清空后再按一次退格退出搜索
        hotkeys('backspace', { element: document }, (e) => {
            if (e.target.id === 'searchInput') return; // 交给原生输入
            if (!this.searchActive) return;
            e.preventDefault();
            const input = document.getElementById('searchInput');
            const q = this.searchQuery || '';
            if (q.length > 0) {
                const next = q.slice(0, -1);
                this.searchQuery = next;
                if (input) input.value = next;
                this.updateCenterPanel();
                // 保持指向第一项更自然
                this.panels.center.selectedIndex = Math.min(this.panels.center.selectedIndex, Math.max(0, this.panels.center.files.length - 1));
                this.updateRightPanel();
                this.render();
            } else {
                // 空字符串再退格：退出搜索
                this.searchActive = false;
                if (input) input.value = '';
                this.updateCenterPanel();
                this.render();
            }
        });
        
        hotkeys('esc', { element: document }, (e) => { 
            e.preventDefault(); 
            if (e.target.id === 'searchInput') {
                e.target.blur();
            } else {
                this.goBack();
            }
        });
        
        hotkeys('/', { element: document }, (e) => { 
            e.preventDefault(); 
            this.focusSearch(); 
        });
        
        hotkeys('g+g', { element: document }, (e) => { 
            if (e.target.id !== 'searchInput') {
                e.preventDefault(); 
                this.goToTop(); 
            }
        });
        
        hotkeys('shift+g', { element: document }, (e) => { 
            if (e.target.id !== 'searchInput') {
                e.preventDefault(); 
                this.goToBottom(); 
            }
        });
    }


    
    // 设置鼠标事件
    setupMouseEvents() {
        // 为每个面板添加点击事件
        ['left', 'center', 'right'].forEach(panelName => {
            const panel = document.getElementById(panelName + 'List');
            if (panel) {
                panel.addEventListener('click', (e) => {
                    const fileElement = e.target.closest('.ya-file');
                    if (fileElement) {
                        e.stopPropagation(); // 阻止事件冒泡
                        const index = parseInt(fileElement.dataset.index);

                        // 确保索引有效
                        if (index >= 0 && index < this.panels[panelName].files.length) {
                            // 无论点击哪个面板，都保持焦点在中间面板
                            this.focusedPanel = 'center';
                            this.panels[panelName].selectedIndex = index;

                            // 如果点击的是中间面板，直接更新预览
                            if (panelName === 'center') {
                                this.updateRightPanel();
                            }

                            this.render();

                            // 双击打开（只对中间面板有效）
                            if (e.detail === 2 && panelName === 'center') {
                                this.openSelected();
                            }
                        }
                    }
                });

                // 键盘导航支持
                panel.addEventListener('keydown', (e) => {
                    if (e.target.classList.contains('ya-file')) {
                        const index = parseInt(e.target.dataset.index);
                        switch (e.key) {
                            case 'Enter':
                            case ' ':
                                e.preventDefault();
                                if (index >= 0 && index < this.panels[panelName].files.length) {
                                    // 无论在哪个面板，都保持焦点在中间
                                    this.focusedPanel = 'center';
                                    this.panels[panelName].selectedIndex = index;
                                    this.openSelected();
                                }
                                break;
                            case 'ArrowUp':
                                e.preventDefault();
                                this.moveUp();
                                break;
                            case 'ArrowDown':
                                e.preventDefault();
                                this.moveDown();
                                break;
                        }
                    }
                });
            }
        });

        // 删除右侧预览区域的点击事件，确保焦点永远在中间面板
    }
    
    // 返回终端
    goBack() {
        if (window.history.length > 1) {
            window.history.back();
        } else {
            // 无历史时，回到 index 并携带当前目录
            const from = this.currentPath || 'notes';
            window.location.href = `../index.html?path=${encodeURIComponent(from)}`;
        }
    }

    // 导航方法 - 模仿yazi的逻辑
    navigateLeft() {
        // h键：返回上级目录
        const parent = this.getParentPath(this.currentPath);
        if (parent) {
            this.currentPath = parent;
            this.panels.center.selectedIndex = 0;
            this.focusedPanel = 'center'; // 确保焦点在中间
            this.updateAllPanels().then(() => this.render());
        }
    }

    navigateRight() {
        // l键：根据选中项类型决定行为
        const selectedFile = this.getSelectedFile();
        if (!selectedFile) return;

        if (selectedFile.isDir) {
            // 进入目录
            this.currentPath = selectedFile.path;
            this.panels.center.selectedIndex = 0;
            this.focusedPanel = 'center'; // 确保焦点在中间
            this.updateAllPanels().then(() => this.render());
        } else if (selectedFile.isFile) {
            // 打开文件
            this.openFile(selectedFile);
        }
    }
    
    moveUp() {
        const panel = this.panels[this.focusedPanel];
        if (panel.files.length > 0) {
            const oldIndex = panel.selectedIndex;
            panel.selectedIndex = Math.max(0, panel.selectedIndex - 1);
            if (oldIndex !== panel.selectedIndex) {
                // 更新预览 - 支持所有面板
                this.updateRightPanel();
                this.render();
            }
        }
    }

    moveDown() {
        const panel = this.panels[this.focusedPanel];
        if (panel.files.length > 0) {
            const oldIndex = panel.selectedIndex;
            panel.selectedIndex = Math.min(panel.files.length - 1, panel.selectedIndex + 1);
            if (oldIndex !== panel.selectedIndex) {
                // 更新预览 - 支持所有面板
                this.updateRightPanel();
                this.render();
            }
        }
    }
    
    goToTop() {
        const panel = this.panels[this.focusedPanel];
        if (panel.files.length > 0) {
            const oldIndex = panel.selectedIndex;
            panel.selectedIndex = 0;
            if (oldIndex !== panel.selectedIndex) {
                // 更新预览 - 支持所有面板
                this.updateRightPanel();
                this.render();
            }
        }
    }
    
    goToBottom() {
        const panel = this.panels[this.focusedPanel];
        if (panel.files.length > 0) {
            const oldIndex = panel.selectedIndex;
            panel.selectedIndex = Math.max(0, panel.files.length - 1);
            if (oldIndex !== panel.selectedIndex) {
                // 更新预览 - 支持所有面板
                this.updateRightPanel();
                this.render();
            }
        }
    }
    
    switchPanel() {
        // 面板切换功能已完全移除，永远保持焦点在中间面板
        // 所有操作都在中心面板进行
    }
    
    // 打开选中的文件或目录
    openSelected() {
        const selectedFile = this.getSelectedFile();
        if (!selectedFile) return;

        if (selectedFile.isDir) {
            // 进入目录
            this.currentPath = selectedFile.path;
            this.panels.center.selectedIndex = 0;
            this.focusedPanel = 'center'; // 确保焦点在中间
            this.updateAllPanels().then(() => this.render());
        } else if (selectedFile.isFile) {
            // 打开文件
            this.openFile(selectedFile);
        }
    }
    
    // 打开文件 - 复用原项目的 reader 逻辑
    openFile(file) {
        if (!file || !file.isFile) return;
        
        // 构建 reader URL，复用原项目的阅读器
        const articleDir = file.path.split('/').slice(0, -1).join('/') || 'notes';
        const url = '../reader.html?file=' + encodeURIComponent(file.path) + '&from=' + encodeURIComponent(articleDir);
        
        // 页面跳转到 reader
        window.location.href = url;
    }
    
    // 聚焦搜索框
    focusSearch() {
        const searchInput = document.getElementById('searchInput');
        searchInput.focus();
        searchInput.select();
    }
    
    // 聚焦中心面板
    focusCenter() {
        this.focusedPanel = 'center';
        this.render();
    }
    
    // 统一的错误处理方法
    handleError(message, error, showToUser = false) {
        // 在开发模式下输出详细错误信息
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            console.error(message, error);
        }
        
        // 如果需要向用户显示错误
        if (showToUser) {
            this.showError(`${message}: ${error.message}`);
        }
    }
    
    // 显示错误信息给用户
    showError(message) {
        const statusBar = document.getElementById('statusBar');
        if (statusBar) {
            statusBar.innerHTML = `<span style="color: #ff6b6b;">错误: ${message}</span>`;
        }
    }
    
    // 统一的图标渲染方法 - 优化性能
    renderIcons() {
        if (window.feather && typeof feather.replace === 'function') {
            feather.replace({ 'stroke-width': 1.6 });
        }
    }
    
    // 获取文件图标 - 提取重复逻辑
    getFileIcon(file) {
        if (file.name === '..') return 'arrow-up';
        if (file.isDir) return 'folder';
        if (file.type === 'md') return 'file-text';
        if (file.type === 'image') return 'image';
        if (file.type === 'code') return 'code';
        return 'file';
    }
    
    // 渲染界面 - 拆分版本
    render() {
        const startTime = performance.now();
        
        this.renderUI();
        this.renderIcons();
        this.logPerformance(startTime);
    }
    
    // 渲染UI组件
    renderUI() {
        this.renderPath();
        this.renderLeftPanel();
        this.renderCenterPanel();
        this.renderRightPanel();
        this.renderStatus();
        this.updatePanelFocus();
    }
    
    // 性能日志记录
    logPerformance(startTime) {
        const endTime = performance.now();
        const renderTime = endTime - startTime;
        
        this.performanceMonitor.renderCount++;
        this.performanceMonitor.totalRenderTime += renderTime;
        this.performanceMonitor.lastRenderTime = renderTime;
        
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            console.log(`Render #${this.performanceMonitor.renderCount}: ${renderTime.toFixed(2)}ms`);
        }
    }
    
    // 更新面板焦点指示
    updatePanelFocus() {
        // 移除所有面板的焦点类
        document.querySelectorAll('.ya-panel').forEach(panel => {
            panel.classList.remove('focused');
        });
        
        // 为当前焦点面板添加焦点类
        const focusedPanelElement = document.querySelector(`.ya-${this.focusedPanel}`);
        if (focusedPanelElement) {
            focusedPanelElement.classList.add('focused');
        }
    }
    
    // 渲染路径显示
    renderPath() {
        const pathDisplay = document.getElementById('pathDisplay');
        // 显示以 notes 开头的完整路径，不再使用 '~' 提示
        const displayPath = this.currentPath && this.currentPath.length > 0
            ? this.currentPath
            : 'notes';
        pathDisplay.textContent = displayPath;
    }
    
    // 渲染左侧面板
    renderLeftPanel() {
        this.renderFileList('leftList', this.panels.left, 'left');
    }
    
    // 渲染中心面板
    renderCenterPanel() {
        this.renderFileList('centerList', this.panels.center, 'center');
    }
    
    // 渲染文件列表 - 优化版本
    renderFileList(elementId, panel, panelName) {
        const container = document.getElementById(elementId);
        if (!container) return;
        
        if (panel.files.length === 0) {
            container.innerHTML = '';
            return;
        }
        
        const html = panel.files.map((file, index) => {
            const isSelected = index === panel.selectedIndex;
            const isFocused = panelName === this.focusedPanel && isSelected;
            const classes = [
                'ya-file',
                file.isDir ? 'dir' : 'file',
                file.type,
                isSelected ? 'selected' : '',
                isFocused ? 'focused' : ''
            ].filter(Boolean).join(' ');
            
            const sizeText = file.isFile && file.size > 0 
                ? this.formatFileSize(file.size) 
                : '';

            // 使用统一的图标选择方法
            const icon = this.getFileIcon(file);
            
            return `
                <div class="${classes}" data-index="${index}" data-path="${file.path}" role="listitem" aria-label="${file.isDir ? '目录' : '文件'}: ${file.name}" tabindex="0">
                    <div class="ya-file-icon" data-feather="${icon}" aria-hidden="true"></div>
                    <div class="ya-file-name">${this.escapeHtml(file.name)}</div>
                    <div class="ya-file-size">${sizeText}</div>
                </div>
            `;
        }).join('');
        
        container.innerHTML = html;
        
        // 滚动到选中项
        if (panel.selectedIndex >= 0) {
            const selectedElement = container.children[panel.selectedIndex];
            if (selectedElement) {
                selectedElement.scrollIntoView({ block: 'nearest' });
            }
        }
    }
    
    // 渲染右侧预览面板 - 优化版本
    renderRightPanel() {
        const container = document.getElementById('previewContent');
        if (!container) return;
        
        const panel = this.panels.right;
        
        // 清除之前的类
        container.className = 'ya-preview-content';
        
        switch (panel.type) {
            case 'loading':
                container.classList.add('loading');
                container.textContent = panel.content;
                break;
                
            case 'error':
                container.classList.add('error');
                container.textContent = panel.content;
                break;
                
            case 'directory':
                container.innerHTML = panel.files ? this.renderDirectoryPreview(panel.files) : '';
                break;
                
            case 'md':
                container.classList.add('markdown');
                if (window.marked && window.DOMPurify) {
                    this.renderMarkdownContent(container, panel.content);
                } else {
                    // 降级处理：显示原始markdown
                    container.innerHTML = `<pre class="markdown-fallback">${this.escapeHtml(panel.content)}</pre>`;
                }
                break;
                
            case 'code':
                container.innerHTML = `<pre><code>${this.escapeHtml(panel.content)}</code></pre>`;
                break;
                
            default:
                container.textContent = panel.content || '';
                break;
        }

        this.applyModeToPreview();
    }
    
    // 渲染目录预览 - 优化版本
    renderDirectoryPreview(files) {
        if (files.length === 0) return '';
        
        const html = files.slice(0, 20).map(file => {
            // 使用统一的图标选择方法
            const icon = this.getFileIcon(file);
            return `
            <div class="ya-file ${file.isDir ? 'dir' : 'file'} ${file.type}">
                <div class="ya-file-icon" data-feather="${icon}"></div>
                <div class="ya-file-name">${this.escapeHtml(file.name)}</div>
                <div class="ya-file-size">${file.isFile && file.size > 0 ? this.formatFileSize(file.size) : ''}</div>
            </div>`;
        }).join('');
        const more = files.length > 20 ? '<div class="ya-file"><span class="ya-file-icon" data-feather="more-horizontal"></span><div class="ya-file-name">... 更多文件</div></div>' : '';
        return html + more;
    }
    
    // 渲染状态栏
    renderStatus() {
        const selectedFile = this.getSelectedFile();
        const fileInfo = document.getElementById('fileInfo');
        const statusBar = document.getElementById('statusBar');
        
        if (selectedFile && fileInfo) {
            const info = [];
            if (selectedFile.isFile) {
                info.push(`${selectedFile.size > 0 ? this.formatFileSize(selectedFile.size) : '0B'}`);
            }
            if (selectedFile.mtime) {
                info.push(selectedFile.mtime);
            }
            if (this.panels.center.files.length > 0) {
                info.push(`${this.panels.center.selectedIndex + 1}/${this.panels.center.files.length}`);
            }
            
            fileInfo.textContent = info.join(' | ');
        }
        
        // 更新状态栏显示当前焦点面板
        if (statusBar) {
            const panelNames = {
                'left': '上级目录',
                'center': '当前目录', 
                'right': '预览'
            };
            const keybind = statusBar.querySelector('.ya-keybind');
            if (keybind) {
                keybind.textContent = `[当前目录] h:上级 jk:移动 l:进入/打开 Enter:打开 /:搜索 Esc:返回`;
            }
        }
    }
    
    // 优化的markdown渲染方法
    renderMarkdownContent(container, content) {
        // 立即显示加载状态
        container.innerHTML = '<div class="markdown-loading">正在渲染markdown...</div>';
        
        // 使用requestAnimationFrame确保更好的性能
        requestAnimationFrame(() => {
            try {
                // 优化的markdown选项
                const options = {
                    breaks: true,
                    gfm: true,
                    headerIds: false,
                    mangle: false,
                    pedantic: false,
                    sanitize: false,
                    silent: true, // 静默模式，减少警告
                    smartLists: true,
                    smartypants: false,
                    xhtml: false
                };
                
                // 对于超长内容，先截断再解析
                let processContent = content;
                if (content.length > 50000) {
                    processContent = content.substring(0, 50000) + '\n\n*[内容过长，已截断显示]*';
                }
                
                const html = marked.parse(processContent, options);
                const sanitizedHtml = DOMPurify.sanitize(html, {
                    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
                    ALLOWED_ATTR: ['href', 'target', 'rel'] // 只允许链接相关属性
                });
                
                container.innerHTML = sanitizedHtml;
                this.applyModeToPreview();
                
            } catch (error) {
                // 统一错误处理
                this.handleError('Markdown 渲染失败', error);
                // 降级到原始文本显示
                container.innerHTML = `<pre class="markdown-error">${this.escapeHtml(content)}</pre>`;
            }
        });
    }

    // 根据 mode 设置预览区域（尤其是 markdown）的主题属性
    applyModeToPreview() {
        const isLight = document.documentElement.classList.contains('mode-light');
        const md = document.getElementById('previewContent');
        if (md) {
            md.setAttribute('data-theme', isLight ? 'light' : 'dark');
        }
    }
    
    // 清理资源
    destroy() {
        // 清理事件监听器
        if (window.hotkeys) {
            hotkeys.unbind();
        }
        
        // 清理定时器
        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
        }
        
        // 清理DOM引用
        this.fsData = null;
        this.fuse = null;
    }
    
    // 工具方法
    formatFileSize(bytes) {
        if (bytes === 0) return '0B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// 初始化应用（带幂等保护）
document.addEventListener('DOMContentLoaded', () => {
    if (window.__YA_BOOTED) return;
    window.__YA_BOOTED = true;
    new YaExplorer();
});
