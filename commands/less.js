/* less command - view file content with pagination */

(function() {
  const lessCommand = {
    less: {
      help: 'less <file> 分页查看文件内容',
      async run(args, { println, normalizePath, getNode, isFile }) {
        if (args.length === 0) {
          println('用法: less <filename>');
          return;
        }
        
        const filename = args[0];
        const filePath = normalizePath(filename);
        const node = getNode(filePath);
        
        if (!isFile(node)) {
          println(`less: ${filename}: 文件不存在`);
          return;
        }
        
        try {
          const res = await fetch('./' + node.path);
          if (!res.ok) throw new Error('无法读取文件');
          const content = await res.text();
          const lines = content.split('\n');
          
          println('─'.repeat(60));
          println(`查看文件: ${filename} (按回车继续，输入q退出)`);
          println('─'.repeat(60));
          
          // 分页显示，每页显示10行
          const pageSize = 10;
          let currentPage = 0;
          const totalPages = Math.ceil(lines.length / pageSize);
          
          const showPage = (page) => {
            const start = page * pageSize;
            const end = Math.min(start + pageSize, lines.length);
            
            for (let i = start; i < end; i++) {
              println(`${(i + 1).toString().padStart(4)}: ${lines[i]}`);
            }
            
            if (page < totalPages - 1) {
              println('');
              println(`--- 第 ${page + 1}/${totalPages} 页 (按回车继续，输入q退出) ---`);
            } else {
              println('');
              println('─'.repeat(60));
              println(`文件结束 (共 ${lines.length} 行)`);
            }
          };
          
          // 显示第一页
          showPage(currentPage);
          
        } catch (error) {
          println(`less: 读取文件 ${filename} 时出错: ${error.message}`);
        }
      },
    }
  };

  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(lessCommand);
  }
})();
