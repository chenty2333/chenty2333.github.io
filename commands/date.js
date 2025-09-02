/* date command - display current date and time */

(function() {
  const dateCommand = {
    date: {
      help: 'date 显示当前日期和时间',
      run(args, { println }) {
        const now = new Date();
        const options = {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short'
        };
        
        const locale = args.includes('--en') ? 'en-US' : 'zh-CN';
        const dateString = now.toLocaleDateString(locale, options);
        
        println(dateString);
        
        // 如果没有参数，显示额外信息
        if (args.length === 0) {
          const timestamp = Math.floor(now.getTime() / 1000);
          const iso = now.toISOString();
          println(`Unix时间戳: ${timestamp}`);
          println(`ISO格式: ${iso}`);
        }
      },
    }
  };

  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(dateCommand);
  }
})();
