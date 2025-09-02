/* wc command - word, line, character, and byte count */

(function() {
  const wcCommand = {
    wc: {
      help: 'wc [选项] <file> 统计文件行数、字数、字符数 (-l行数 -w字数 -c字符数)',
      async run(args, { println, normalizePath, getNode, isFile }) {
        const options = {
          lines: args.includes('-l'),
          words: args.includes('-w'),
          chars: args.includes('-c'),
          all: !args.includes('-l') && !args.includes('-w') && !args.includes('-c')
        };
        
        const filename = args.find(arg => !arg.startsWith('-'));
        
        if (!filename) {
          println('用法: wc [选项] <filename>');
          println('选项:');
          println('  -l    只显示行数');
          println('  -w    只显示字数');
          println('  -c    只显示字符数');
          println('  无选项 显示所有统计信息');
          return;
        }
        
        const filePath = normalizePath(filename);
        const node = getNode(filePath);
        
        if (!isFile(node)) {
          println(`wc: ${filename}: 文件不存在`);
          return;
        }
        
        try {
          const res = await fetch('./' + node.path);
          if (!res.ok) throw new Error('无法读取文件');
          const content = await res.text();
          
          // 统计信息
          const lines = content.split('\n').length;
          const words = content.trim() ? content.trim().split(/\s+/).length : 0;
          const chars = content.length;
          const bytes = new Blob([content]).size;
          
          let output = '';
          
          if (options.all) {
            output = `${lines.toString().padStart(8)} ${words.toString().padStart(8)} ${chars.toString().padStart(8)} ${filename}`;
          } else {
            const parts = [];
            if (options.lines) parts.push(lines.toString().padStart(8));
            if (options.words) parts.push(words.toString().padStart(8));
            if (options.chars) parts.push(chars.toString().padStart(8));
            output = parts.join('') + ` ${filename}`;
          }
          
          println(output);
          
          // 显示统计说明
          if (options.all) {
            println(`  行数    字数    字符数  文件名`);
          }
          
        } catch (error) {
          println(`wc: 读取文件 ${filename} 时出错: ${error.message}`);
        }
      },
    }
  };

  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(wcCommand);
  }
})();
