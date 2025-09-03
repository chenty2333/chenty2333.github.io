(function() {
  if (!window.TerminalCommands) {
    console.error('TerminalCommands not found.');
    return;
  }

  const yaCommand = {
    name: 'ya',
    description: '打开 ya, 一个现代文件浏览器.',
    usage: 'ya',
    run: function(args, context) {
      const startPath = context?.cwd || context?.env?.ROOT || 'notes';
      context.println('正在打开 ya...');
      // 将当前工作目录传递给 ya，便于保持目录上下文
      const url = `./ya/ya.html?path=${encodeURIComponent(startPath)}`;
      // 立即跳转，不再返回永不完成的 Promise，避免从 ya 返回后无新提示符的问题
      window.location.href = url;
      return; // 同步返回以便终端渲染新的提示符（在跳转前可能短暂可见）
    }
  };

  window.TerminalCommands.register(yaCommand.name, yaCommand);
})();
