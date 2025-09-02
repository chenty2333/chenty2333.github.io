/* File System Commands */

(function() {
  const fileCommands = {
    ls: {
      help: '列出目录内容',
      run(args, { println, listDir, normalizePath, cwd }) {
        const flags = { long: false, all: false };
        const paths = [];
        for (const a of args) {
          if (a === '-l') flags.long = true;
          else if (a === '-a') flags.all = true;
          else if (a === '-la' || a === '-al') { flags.long = true; flags.all = true; }
          else paths.push(a);
        }
        const target = normalizePath(paths[0] || cwd);
        const res = listDir(target, { all: flags.all, long: flags.long });
        if (!res.ok) return println(res.err);
        res.lines.forEach((l) => println(l));
      },
    },

    cd: {
      help: '切换目录',
      run(args, { println, normalizePath, getNode, isDir, env, setCwd, renderPrompt }) {
        const target = normalizePath(args[0] || env.ROOT);
        const node = getNode(target);
        if (!isDir(node)) return println('目录不存在');
        setCwd(target);
        renderPrompt();
      },
    },

    pwd: {
      help: '显示当前路径',
      run(args, { println, cwd, env }) {
        const rel = cwd.startsWith(env.ROOT) ? '~' + cwd.slice(env.ROOT.length) : cwd;
        println(rel);
      },
    },

    tree: {
      help: '树形展示目录',
      run(args, { println, normalizePath, cwd, tree }) {
        const target = normalizePath(args[0] || cwd);
        const lines = [target + '/', ...tree(target)];
        lines.forEach((l) => println(l));
      },
    },

    read: {
      help: '读取文件/打开文章',
      run(args, { println, normalizePath, getNode, isFile, env }) {
        if (!args[0]) return println('用法: read <file> [--new]');
        const isNew = args.includes('--new');
        const p = normalizePath(args[0]);
        const node = getNode(p);
        if (!isFile(node)) return println('文件不存在');
        const articleDir = node.path.split('/').slice(0, -1).join('/') || env.ROOT;
        const url = './reader.html?file=' + encodeURIComponent(node.path) + '&from=' + encodeURIComponent(articleDir);
        if (isNew) {
          window.open(url, '_blank');
        } else {
          location.href = url;
        }
      },
    },
  };

  // 注册到全局命令系统
  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(fileCommands);
  }
})();
