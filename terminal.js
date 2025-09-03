/* Terminal-Style Notes Website - core terminal logic */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const output = $('#output');
  let cmd = null; // created inline
  let promptEl = null; // created inline
  const app = document.getElementById('app');
  const headerBtn = document.getElementById('header-btn');

  // --- Persistent state ---
  const LS_KEYS = {
    env: 'tn_env',
    alias: 'tn_alias',
  mode: 'tn_mode',
  };
  const SS_KEYS = {
    cwd: 'tn_cwd',
  out: 'tn_out',
  hist: 'tn_hist',
  };

  const defaultEnv = {
    PS1: '$',
    THEME: 'retro',
    FONTSIZE: 16,
  ROOT: 'notes',
  OUTPUT_MAX: 500,
  };

  const env = loadJSON(LS_KEYS.env, defaultEnv);
  const aliasMap = loadJSON(LS_KEYS.alias, {});
  let history = [];
  let histIdx = -1;
  let fsIndex = {};
  let cwd = sessionStorage.getItem(SS_KEYS.cwd) || env.ROOT;

  applyTheme(env.THEME);
  applyFontSize(env.FONTSIZE);
  initMode();
  renderPrompt();

  // Warn if opened as file:// (fetch will fail)
  if (location.protocol === 'file:') {
    println('检测到使用 file:// 方式打开页面，无法加载 data/fs.json。请使用本地服务器或部署到 GitHub Pages。');
  }

  // Load FS
  fetch('./data/fs.json?_=' + Date.now())
    .then((r) => r.json())
    .then((json) => {
      fsIndex = json;
      // Allow path from query ?path=...
      const params = new URLSearchParams(location.search);
      const qPath = params.get('path');
      if (qPath && nodeExists(qPath)) {
        cwd = normalizePath(qPath);
        sessionStorage.setItem(SS_KEYS.cwd, cwd);
        renderPrompt();
      }
      // First try restoring previous session output/history
      restoreState();
      const hasSaved = output.childElementCount > 0;
      // Only show welcome/MOTD when there's no prior session output
      if (!hasSaved) {
        println(`欢迎来到 Terminal Notes. 输入 'help' 查看命令, 'read readme.md' 查看指南.`);
      }
      ensureInputLine();
      focusInput();
    })
    .catch((err) => {
      println('加载文件系统索引失败 data/fs.json。请通过本地服务器访问 (如 VS Code Live Server 或 python http.server)。');
      console.error('Failed to load fs.json', err);
    });

  // --- Utilities ---
  function loadJSON(key, fallback) {
    try {
      const s = localStorage.getItem(key);
      return s ? { ...fallback, ...JSON.parse(s) } : { ...fallback };
    } catch {
      return { ...fallback };
    }
  }
  function saveJSON(key, obj) {
    localStorage.setItem(key, JSON.stringify(obj));
  }
  function applyTheme(name) {
    app.classList.remove('theme-retro', 'theme-amber', 'theme-modern');
    const cls = name === 'amber' ? 'theme-amber' : name === 'modern' ? 'theme-modern' : 'theme-retro';
    app.classList.add(cls);
  }
  function initMode() {
    const root = document.documentElement;
    const saved = localStorage.getItem(LS_KEYS.mode) || 'mode-light';
    const isLight = saved === 'mode-light';
    
    // 确保 app 元素和根元素都有正确的模式类
    // (根元素应该已经由内联脚本设置，这里是确保同步)
    [root, app].forEach(el => {
      el.classList.toggle('mode-light', isLight);
      el.classList.toggle('mode-dark', !isLight);
    });
    
    if (headerBtn) {
      // 主页：按钮显示为 emoji，并承担明暗切换功能
      headerBtn.textContent = '🌗';
      headerBtn.title = '切换明暗';
      headerBtn.addEventListener('click', () => {
        const newIsLight = !root.classList.contains('mode-light');
        [root, app].forEach(el => {
          el.classList.toggle('mode-light', newIsLight);
          el.classList.toggle('mode-dark', !newIsLight);
        });
        localStorage.setItem(LS_KEYS.mode, newIsLight ? 'mode-light' : 'mode-dark');
      });
    }
  }
  function applyFontSize(px) {
    document.documentElement.style.setProperty('--terminal-font-size', `${px || 16}px`);
  }
  function renderPrompt() {
    if (!promptEl) return;
    const rel = cwd.startsWith(env.ROOT) ? '~' + cwd.slice(env.ROOT.length) : cwd;
    promptEl.textContent = `${rel}${env.PS1 ?? '$'}`;
  }
  function println(text, cls) {
    const div = document.createElement('div');
    div.className = 'line' + (cls ? ' ' + cls : '');
    div.textContent = text;
    output.appendChild(div);
    output.scrollTop = output.scrollHeight;
    trimOutput();
  }
  function printHTML(html) {
    const div = document.createElement('div');
    div.className = 'line';
    // Attempt to sanitize if DOMPurify is available; otherwise fall back to textContent to avoid XSS
    if (window.DOMPurify) {
      div.innerHTML = DOMPurify.sanitize(html);
    } else {
      // no sanitizer available: render as plain text to avoid XSS
      div.textContent = html;
    }
    output.appendChild(div);
    output.scrollTop = output.scrollHeight;
    trimOutput();
  }
  function trimOutput(max) {
    const cap = Number(env.OUTPUT_MAX) || 80;
    while (output.childElementCount > (max || cap)) {
      output.removeChild(output.firstElementChild);
    }
  }
  function focusInput() { cmd?.focus(); }

  // Save/restore session state (output lines + history)
  function saveState() {
    try {
      // Save only plain text contents of each visible line to avoid persisting raw HTML
      const lines = Array.from(output.children)
        .filter((el) => el.classList.contains('line'))
        .map((el) => ({ text: el.textContent || '', cls: el.className || '' }));
      sessionStorage.setItem(SS_KEYS.out, JSON.stringify(lines));
      sessionStorage.setItem(SS_KEYS.hist, JSON.stringify(history));
    } catch {}
  }
  function restoreState() {
    try {
      const savedOut = JSON.parse(sessionStorage.getItem(SS_KEYS.out) || '[]');
      const savedHist = JSON.parse(sessionStorage.getItem(SS_KEYS.hist) || '[]');
      if (Array.isArray(savedOut) && savedOut.length) {
        for (const item of savedOut) {
          const div = document.createElement('div');
          div.className = item.cls || 'line';
          // Restore as textContent to avoid executing any HTML/script that may have been stored
          div.textContent = item.text || '';
          output.appendChild(div);
        }
        output.scrollTop = output.scrollHeight;
      }
      if (Array.isArray(savedHist)) history = savedHist;
    } catch {}
  }
  window.addEventListener('beforeunload', saveState);

  function ensureInputLine() {
    // 检查是否已经有输入行，避免重复创建
    const existing = output.querySelector('.input-line');
    if (existing) {
      focusInput();
      return;
    }
    
    // Create a new inline input line and attach listeners
    const line = document.createElement('div');
    line.className = 'input-line';
    promptEl = document.createElement('span');
    promptEl.id = 'prompt';
    promptEl.className = 'prompt';
    cmd = document.createElement('input');
    cmd.id = 'cmd';
    cmd.className = 'cmd';
    cmd.type = 'text';
    cmd.spellcheck = false;
    cmd.autocomplete = 'off';
  // Mobile typing optimizations
  cmd.setAttribute('autocapitalize', 'none');
  cmd.setAttribute('autocorrect', 'off');
  cmd.setAttribute('inputmode', 'text');
  cmd.setAttribute('enterkeyhint', 'send');
    cmd.setAttribute('aria-label', 'command input');
    renderPrompt();
    line.appendChild(promptEl);
    line.appendChild(cmd);
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
    hookInputEvents();
    focusInput();
  }

  function isDir(node) { return node && typeof node === 'object' && !node.type; }
  function isFile(node) { return node && typeof node === 'object' && node.type === 'file'; }

  function getNode(pathStr) {
    const parts = normalizePath(pathStr).split('/').filter(Boolean);
    let node = fsIndex;
    for (const p of parts) {
      if (!node || !node[p]) return undefined;
      node = node[p];
    }
    return node;
  }
  function nodeExists(pathStr) { return !!getNode(pathStr); }

  function normalizePath(pathStr) {
    if (!pathStr) return cwd;
    let p = pathStr.trim();
    // ~ mapping to ROOT
    if (p.startsWith('~')) {
      p = env.ROOT + p.slice(1);
    }
    // relative
    if (!p.startsWith('/')) {
      if (!p.startsWith(env.ROOT)) p = cwd + '/' + p;
    }
    const segs = [];
    for (const part of p.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') segs.pop(); else segs.push(part);
    }
    return segs.join('/');
  }

  function listDir(pathStr, { all = false, long = false } = {}) {
    const node = getNode(pathStr);
    if (!isDir(node)) return { ok: false, err: '不是目录' };
    const names = Object.keys(node).filter((k) => all || !k.startsWith('.'));
    names.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    if (!long) return { ok: true, lines: [names.join('  ')] };
    const lines = names.map((name) => {
      const child = node[name];
      if (isDir(child)) return `drwxr-xr-x  ${name}/`;
      if (isFile(child)) return `-rw-r--r--  ${name}  ${child.size || 0}  ${child.mtime || ''}`;
      return name;
    });
    return { ok: true, lines };
  }

  function tree(pathStr, prefix = '') {
    const node = getNode(pathStr);
    if (!isDir(node)) return [];
    const entries = Object.keys(node).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const lines = [];
    entries.forEach((name, idx) => {
      const child = node[name];
      const isLast = idx === entries.length - 1;
      const branch = (isLast ? '└── ' : '├── ') + name + (isDir(child) ? '/' : '');
      lines.push(prefix + branch);
      if (isDir(child)) {
        const nextPrefix = prefix + (isLast ? '    ' : '│   ');
        lines.push(...tree(pathStr + '/' + name, nextPrefix));
      }
    });
    return lines;
  }

  function pathComplete(partial) {
    // return completion candidates for last segment
    const idx = partial.lastIndexOf('/');
    let base = '';
    let prefix = partial;
    if (idx >= 0) { base = partial.slice(0, idx); prefix = partial.slice(idx + 1); }
    const dirPath = base || cwd;
    const node = getNode(dirPath);
    if (!isDir(node)) return [];
    return Object.keys(node).filter((n) => n.startsWith(prefix)).map((n) => (base ? base + '/' + n : n));
  }

  // --- Commands ---
  // 获取所有注册的命令
  function getCommands() {
    return window.TerminalCommands ? window.TerminalCommands.getAll() : {};
  }

  function unquote(s) {
    if (!s) return s;
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    return s;
  }
  function parseMaybeNumber(v) {
    if (v === undefined || v === null) return v;
    if (/^-?\d+(?:\.\d+)?$/.test(String(v))) return Number(v);
    return v;
  }

  // 设置当前工作目录的辅助函数
  function setCwd(newCwd) {
    cwd = newCwd;
    sessionStorage.setItem(SS_KEYS.cwd, cwd);
  }

  // --- Input handling ---
  function hookInputEvents() {
  cmd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = cmd.value.trim();
      // Echo the command and replace input line first
      const echo = document.createElement('div');
      echo.className = 'line';
      const promptText = promptEl ? promptEl.textContent : '$';
      echo.innerHTML = `<span class="muted">${escapeHTML(promptText)} ${escapeHTML(text)}</span>`;
      const last = output.lastElementChild;
      if (last && last.classList.contains('input-line')) last.remove();
      output.appendChild(echo);
      output.scrollTop = output.scrollHeight;
      
      // 处理命令
      if (text) {
        const commandCompleted = handleLine(text);
        // 如果命令返回 Promise，等待完成后再创建输入行
        if (commandCompleted && typeof commandCompleted.then === 'function') {
          commandCompleted.finally(() => {
            setTimeout(() => ensureInputLine(), 10);
          });
        } else {
          // 同步命令立即创建输入行
          ensureInputLine();
        }
      } else {
        // 空命令直接创建输入行
        ensureInputLine();
      }
    } else if (e.key === 'ArrowUp') {
      if (history.length) {
        histIdx = Math.max(0, histIdx === -1 ? history.length - 1 : histIdx - 1);
        cmd.value = history[histIdx];
        e.preventDefault();
      }
    } else if (e.key === 'ArrowDown') {
      if (history.length) {
        if (histIdx >= 0) histIdx = Math.min(history.length - 1, histIdx + 1);
        cmd.value = history[histIdx] || '';
        e.preventDefault();
      }
    } else if (e.key === 'Tab') {
      const parts = cmd.value.split(/\s+/).filter(Boolean);
      if (parts.length <= 1) {
        const prefix = parts[0] || '';
        const commands = getCommands();
        const cmdNames = Object.keys(commands).concat(Object.keys(aliasMap));
        const cands = cmdNames.filter((n) => n.startsWith(prefix)).sort();
        if (cands.length === 1) {
          cmd.value = cands[0] + ' ';
        } else if (cands.length > 1) {
          printHTML('<span class="muted">' + cands.join('  ') + '</span>');
        }
      } else {
        const last = parts.pop() || '';
        const cands = pathComplete(last);
        if (cands.length === 1) {
          const node = getNode(normalizePath(cands[0]));
          const suffix = isDir(node) ? '/' : '';
          parts.push(cands[0] + suffix);
          cmd.value = parts.join(' ');
        } else if (cands.length > 1) {
          printHTML('<span class="muted">' + cands.join('  ') + '</span>');
        }
      }
      e.preventDefault();
    }
  });
  }

  function handleLine(text) {
    if (!text) return;
    history.push(text);
    histIdx = -1;

    // alias expansion (first token)
    const tokens = tokenize(text);
    if (tokens.length === 0) return;
    const [first, ...rest] = tokens;
    const expanded = aliasMap[first] ? tokenize(aliasMap[first]).concat(rest) : tokens;
    const cmdName = expanded[0];
    const args = expanded.slice(1);
    
    // Get commands from modular system
    const commands = getCommands();
    const handler = commands[cmdName];
    if (!handler) {
      println(`未找到命令: ${cmdName}`);
      return; // 同步返回
    }
    
    try {
      // Create context object with all necessary functions and data
      const context = {
        // Output functions
        println,
        printHTML,
        output,
        
        // File system functions
        normalizePath,
        getNode,
        isDir,
        isFile,
        listDir,
        tree,
        pathComplete,
        
        // State and config
        env,
        defaultEnv,
        aliasMap,
        cwd,
        setCwd,
        
        // Storage functions
        saveJSON,
        LS_KEYS,
        saveState,
        
        // UI functions
        applyTheme,
        applyFontSize,
        renderPrompt,
        
        // Utility functions
        unquote,
        parseMaybeNumber,
        
        // Command completion callback (不再使用)
        onCommandComplete: () => {}
      };
      
      const result = handler.run(args, context);
      
      // 返回执行结果（可能是 Promise）
      if (result && typeof result.then === 'function') {
        return result.catch((err) => {
          println('执行错误: ' + (err?.message || String(err)));
        });
      }
      
      return result; // 同步命令结果
    } catch (err) {
      println('执行错误: ' + (err?.message || String(err)));
      console.error(err);
      return; // 同步返回
    }
  }

  function tokenize(s) {
    const tokens = [];
    let cur = '';
    let quote = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) {
        if (ch === quote) { quote = ''; } else { cur += ch; }
      } else {
        if (ch === '"' || ch === "'") { quote = ch; }
        else if (/\s/.test(ch)) { if (cur) { tokens.push(cur); cur = ''; } }
        else { cur += ch; }
      }
    }
    if (cur) tokens.push(cur);
    return tokens;
  }

  function escapeHTML(s) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    return s.replace(/[&<>"]/g, (c) => map[c]);
  }
  
  // Focus input when clicking terminal, but don't disrupt text selection/copy
  const safeFocus = (e) => {
    const sel = window.getSelection?.()?.toString();
    if (sel?.length > 0) return; // user is selecting text
    const t = e.target;
    if (t?.tagName === 'INPUT' || t?.isContentEditable) return;
    focusInput();
  };
  
  document.getElementById('terminal')?.addEventListener('click', safeFocus);
  output?.addEventListener('click', safeFocus);
})();
