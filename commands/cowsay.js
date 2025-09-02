/* cowsay command - make cow say something */

(function() {
  const cowsayCommand = {
    cowsay: {
      help: 'cowsay <message> 让牛说话',
      run(args, { println }) {
        const message = args.join(' ') || 'Hello Terminal Notes!';
        const msgLen = message.length;
        const topBorder = ' ' + '_'.repeat(msgLen + 2);
        const bottomBorder = ' ' + '-'.repeat(msgLen + 2);
        
        println(topBorder);
        println(`< ${message} >`);
        println(bottomBorder);
        println('        \\   ^__^');
        println('         \\  (oo)\\_______');
        println('            (__)\\       )\\/\\');
        println('                ||----w |');
        println('                ||     ||');
      },
    }
  };

  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(cowsayCommand);
  }
})();
