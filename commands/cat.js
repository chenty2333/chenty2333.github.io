/* cat command - display file contents */

(function() {
  const catCommand = {
    cat: {
      help: 'cat <file> 显示文件内容',
      async run(args, { println, normalizePath, getNode, isFile }) {
        if (!args[0]) return println('用法: cat <file>');
        const p = normalizePath(args[0]);
        const node = getNode(p);
        if (!isFile(node)) return println('文件不存在');
        
        try {
          const res = await fetch('./' + node.path);
          if (!res.ok) throw new Error('无法读取文件');
          const content = await res.text();
          
          // 按行输出，避免超长输出
          const lines = content.split('\n');
          lines.forEach(line => println(line));
        } catch (err) {
          println('cat: ' + err.message);
        }
      },
    }
  };

  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(catCommand);
  }
})();
