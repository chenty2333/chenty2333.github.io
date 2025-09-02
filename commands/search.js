/* Search Commands */

(function() {
  const searchCommands = {
    grep: {
      help: 'grep PATTERN [path] [--content] 搜索文件名(默认)或内容',
      async run(args, { println, normalizePath, cwd, getNode, isDir, isFile }) {
        if (!args[0]) return println('用法: grep PATTERN [path] [--content]');
        const pattern = args[0];
        const wantContent = args.includes('--content');
        const baseArg = args.find((a) => a !== pattern && a !== '--content');
        const basePath = normalizePath(baseArg || cwd);
        const results = new Map(); // path -> kind

        function walk(pathStr) {
          const node = getNode(pathStr);
          if (!node) return;
          if (isDir(node)) {
            Object.keys(node).forEach((name) => walk(pathStr + '/' + name));
          } else if (isFile(node)) {
            if (node.path.toLowerCase().includes(pattern.toLowerCase())) {
              results.set(node.path, results.get(node.path) || 'name');
            }
          }
        }
        walk(basePath);

        if (wantContent) {
          const files = collectFiles(basePath);
          const limit = 50;
          let fetched = 0;
          for (const f of files) {
            if (fetched >= limit) break;
            try {
              const res = await fetch('./' + f.path);
              if (!res.ok) continue;
              const txt = await res.text();
              if (txt.toLowerCase().includes(pattern.toLowerCase())) {
                results.set(f.path, 'content');
              }
              fetched++;
            } catch {}
          }
          if (files.length > limit) println(`(只检查了前 ${limit} 个文件的内容)`);
        }

        if (results.size === 0) return println('无匹配');
        Array.from(results.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .forEach(([p, t]) => println(`${p}  (${t})`));

        function collectFiles(pathStr) {
          const acc = [];
          const node = getNode(pathStr);
          if (!node) return acc;
          if (isDir(node)) {
            Object.keys(node).forEach((name) => acc.push(...collectFiles(pathStr + '/' + name)));
          } else if (isFile(node)) {
            acc.push(node);
          }
          return acc;
        }
      },
    },
  };

  // 注册到全局命令系统
  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(searchCommands);
  }
})();
