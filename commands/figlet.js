/* figlet command - ASCII art text */

(function() {
  const figletCommand = {
    figlet: {
      help: 'figlet <text> ASCII艺术字',
      run(args, { println }) {
        const text = args.join(' ') || 'Terminal';
        // 简化版ASCII艺术字，只支持基本字符
        const chars = {
          'T': ['████████', '   ██   ', '   ██   ', '   ██   '],
          'e': ['███████ ', '██      ', '███████ ', '███████ '],
          'r': ['██████  ', '██   ██ ', '██████  ', '██   ██ '],
          'm': ['██    ██', '████████', '██ ██ ██', '██    ██'],
          'i': ['██', '██', '██', '██'],
          'n': ['██    ██', '███   ██', '██ ██ ██', '██   ███'],
          'a': [' ███████', '██     ██', '███████ ', '██     ██'],
          'l': ['██      ', '██      ', '██      ', '███████ '],
          ' ': ['    ', '    ', '    ', '    ']
        };
        
        const lines = ['', '', '', ''];
        for (const char of text.toLowerCase()) {
          const pattern = chars[char] || chars[' '];
          for (let i = 0; i < 4; i++) {
            lines[i] += pattern[i] + ' ';
          }
        }
        
        lines.forEach(line => println(line));
      },
    }
  };

  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(figletCommand);
  }
})();
