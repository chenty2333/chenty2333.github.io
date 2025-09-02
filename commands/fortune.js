/* fortune command - random quotes and sayings */

(function() {
  const fortuneCommand = {
    fortune: {
      help: 'fortune 显示随机格言',
      run(args, { println }) {
        const fortunes = [
          '在编程的世界里，唯一不变的就是变化。',
          '好的代码就像好的笑话，它不需要解释。',
          '程序员最大的敌人不是Bug，而是需求变更。',
          '代码如诗，但大多数人写的都是打油诗。',
          'Talk is cheap. Show me the code. - Linus Torvalds',
          '生活就像编程，总是会有意想不到的Bug。',
          '优秀的程序员会考虑边界情况，普通的程序员会忽略它们。',
          '代码是写给人看的，只是顺便让计算机执行。',
          '过早的优化是万恶之源。 - Donald Knuth',
          '简单是可靠的前提。 - Edsger Dijkstra',
          '计算机科学中只有两个难题：缓存失效和命名。',
          '任何足够复杂的程序都包含一个临时的、不完整的、有Bug的Lisp实现。',
          '有些人遇到问题时会想："我知道，用正则表达式！"现在他们有两个问题了。',
          '程序员的三大美德：懒惰、急躁和傲慢。 - Larry Wall',
          '调试代码比写代码难一倍。所以如果你很聪明地写代码，你就不够聪明去调试它。'
        ];
        
        const randomFortune = fortunes[Math.floor(Math.random() * fortunes.length)];
        println('');
        println('─'.repeat(Math.min(randomFortune.length + 4, 60)));
        println(`  ${randomFortune}`);
        println('─'.repeat(Math.min(randomFortune.length + 4, 60)));
        println('');
      },
    }
  };

  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(fortuneCommand);
  }
})();
