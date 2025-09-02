/* Terminal Commands Registry */

// 命令注册中心 - 使用传统模块模式兼容浏览器
window.TerminalCommands = (function() {
  const commands = {};

  // 注册命令
  function register(name, handler) {
    commands[name] = handler;
  }

  // 批量注册命令
  function registerAll(commandsObj) {
    Object.assign(commands, commandsObj);
  }

  // 获取命令
  function get(name) {
    return commands[name];
  }

  // 获取所有命令名
  function getNames() {
    return Object.keys(commands);
  }

  // 检查命令是否存在
  function has(name) {
    return name in commands;
  }

  // 执行命令
  function execute(name, args, context) {
    const handler = commands[name];
    if (!handler) {
      throw new Error(`未找到命令: ${name}`);
    }
    return handler.run(args, context);
  }

  // 获取所有命令（用于终端主程序）
  function getAll() {
    return { ...commands };
  }

  return {
    register,
    registerAll,
    get,
    getNames,
    has,
    execute,
    getAll
  };
})();
