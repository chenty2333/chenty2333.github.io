/* Base Terminal Commands */

(function() {
  const baseCommands = {
    echo: {
      help: '打印文本',
      run(args, { println }) {
        println(args.join(' '));
      },
    },

    clear: {
      help: '清空输出',
      run(args, { output, saveState }) {
        output.innerHTML = '';
        // Immediately persist cleared state so refresh won't bring old lines back
        saveState();
      },
    },
  };

  // 注册到全局命令系统
  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(baseCommands);
  }
})();
