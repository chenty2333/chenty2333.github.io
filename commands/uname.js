/* uname command - display system information */

(function() {
  const unameCommand = {
    uname: {
      help: 'uname [选项] 显示系统信息 (-a显示所有信息)',
      run(args, { println }) {
        const all = args.includes('-a') || args.includes('--all');
        
        // 基本系统信息
        const systemName = 'Terminal-OS';
        const nodeName = 'browser-terminal';
        const release = '1.0.0';
        const version = '#1 Web Terminal';
        const machine = navigator.platform;
        
        // 获取浏览器详细信息
        const userAgent = navigator.userAgent;
        let processor = 'WebKit';
        if (userAgent.includes('Chrome')) processor = 'V8';
        else if (userAgent.includes('Firefox')) processor = 'SpiderMonkey';
        else if (userAgent.includes('Safari')) processor = 'JavaScriptCore';
        
        if (all) {
          println(`系统名称: ${systemName}`);
          println(`节点名称: ${nodeName}`);
          println(`发行版本: ${release}`);
          println(`版本信息: ${version}`);
          println(`硬件平台: ${machine}`);
          println(`处理器类型: ${processor}`);
          println(`浏览器引擎: ${userAgent.split(' ').find(part => part.includes('/')) || 'Unknown'}`);
          println(`用户代理: ${userAgent}`);
        } else if (args.length === 0) {
          println(systemName);
        } else {
          // 处理具体选项
          if (args.includes('-s') || args.includes('--kernel-name')) {
            println(systemName);
          }
          if (args.includes('-n') || args.includes('--nodename')) {
            println(nodeName);
          }
          if (args.includes('-r') || args.includes('--kernel-release')) {
            println(release);
          }
          if (args.includes('-v') || args.includes('--kernel-version')) {
            println(version);
          }
          if (args.includes('-m') || args.includes('--machine')) {
            println(machine);
          }
          if (args.includes('-p') || args.includes('--processor')) {
            println(processor);
          }
        }
      },
    }
  };

  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(unameCommand);
  }
})();
