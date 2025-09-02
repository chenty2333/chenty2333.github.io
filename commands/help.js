/* help command - display available commands and usage */

(function() {
  const helpCommand = {
    help: {
      help: '显示帮助',
      run(args, { println }) {
        const txt = [
          '可用命令:',
          '',
          '  ls [-l] [-a]       列出目录',
          '  cd <dir>           切换目录 (.. ../.. ~)',
          '  pwd                显示当前路径',
          '  tree               树形结构',
          '  read <file> [--new] 打开文章',
          '  cat <file>         显示文件内容',
          '  wc [选项] <file>   统计文件信息 (-l -w -c)',
          '  grep PATTERN [path] [--content] 搜索名称/内容',
          '  alias k=v | alias  列出/设置别名',
          '  export K=V         设置环境变量',
          '  config [show|reset] 查看/管理配置',
          '  cowsay <msg>       让牛说话',
          '  figlet <text>      ASCII艺术字',
          '  fortune            随机名言',
          '  date [--en]        显示日期时间',
          '  whoami             显示用户信息',
          '  uname [-a]         系统信息',
          '  echo <text>        打印文本',
          '  clear              清屏',
          '  help               显示此帮助',
          '',
          '- 使用 Tab 键自动补全命令和路径',
        ];
        txt.forEach((l) => println(l));
      },
    }
  };

  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(helpCommand);
  }
})();
