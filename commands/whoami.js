/* whoami command - display current user information */

(function() {
  const whoamiCommand = {
    whoami: {
      help: 'whoami 显示当前用户信息',
      run(args, { println }) {
        // 获取浏览器和系统信息
        const userAgent = navigator.userAgent;
        const platform = navigator.platform;
        const language = navigator.language;
        const cookieEnabled = navigator.cookieEnabled;
        const onLine = navigator.onLine;
        
        // 解析浏览器信息
        let browser = 'Unknown';
        if (userAgent.includes('Chrome')) browser = 'Chrome';
        else if (userAgent.includes('Firefox')) browser = 'Firefox';
        else if (userAgent.includes('Safari')) browser = 'Safari';
        else if (userAgent.includes('Edge')) browser = 'Edge';
        
        // 解析操作系统
        let os = 'Unknown';
        if (platform.includes('Win')) os = 'Windows';
        else if (platform.includes('Mac')) os = 'macOS';
        else if (platform.includes('Linux')) os = 'Linux';
        else if (platform.includes('Android')) os = 'Android';
        else if (platform.includes('iPhone') || platform.includes('iPad')) os = 'iOS';
        
        println('╭─────────────────────────────────╮');
        println('│         用户信息 (whoami)        │');
        println('├─────────────────────────────────┤');
        println(`│ 用户: Terminal用户               │`);
        println(`│ 浏览器: ${browser.padEnd(22)} │`);
        println(`│ 操作系统: ${os.padEnd(20)} │`);
        println(`│ 语言: ${language.padEnd(22)} │`);
        println(`│ Cookie: ${(cookieEnabled ? '启用' : '禁用').padEnd(19)} │`);
        println(`│ 网络状态: ${(onLine ? '在线' : '离线').padEnd(18)} │`);
        println(`│ 屏幕: ${screen.width}x${screen.height}${(' '.repeat(Math.max(0, 15 - (screen.width + 'x' + screen.height).toString().length)))} │`);
        println('╰─────────────────────────────────╯');
      },
    }
  };

  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(whoamiCommand);
  }
})();
