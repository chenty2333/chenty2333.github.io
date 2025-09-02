/* Configuration Commands */

(function() {
  const configCommands = {
    alias: {
      help: 'alias 别名: alias 或 alias ll="ls -la"',
      run(args, { println, aliasMap, saveJSON, LS_KEYS }) {
        if (args.length === 0) {
          Object.entries(aliasMap).forEach(([k, v]) => println(`${k}='${v}'`));
          return;
        }
        const m = args.join(' ').match(/^(\w+)=("([^"]*)"|'([^']*)'|(.+))$/);
        if (!m) return println('用法: alias name="value"');
        const key = m[1];
        const val = m[3] || m[4] || m[5] || '';
        aliasMap[key] = val;
        saveJSON(LS_KEYS.alias, aliasMap);
      },
    },

    export: {
      help: 'export 环境变量: export THEME=retro|amber|modern; export PS1="> "; export OUTPUT_MAX=120',
      run(args, { println, env, saveJSON, LS_KEYS, applyTheme, applyFontSize, renderPrompt, parseMaybeNumber, unquote }) {
        if (args.length === 0) {
          Object.entries(env).forEach(([k, v]) => println(`${k}=${v}`));
          return;
        }
        for (const a of args) {
          const [k, ...rest] = a.split('=');
          const v = rest.join('=');
          if (!k) continue;
          env[k] = parseMaybeNumber(unquote(v));
        }
        saveJSON(LS_KEYS.env, env);
        if (env.THEME) applyTheme(env.THEME);
        if (env.FONTSIZE) applyFontSize(env.FONTSIZE);
        renderPrompt();
      },
    },

    config: {
      help: 'config 配置管理: config [show|reset] 查看/重置所有配置',
      run(args, { println, env, defaultEnv, aliasMap, saveJSON, LS_KEYS, applyTheme, applyFontSize, renderPrompt }) {
        const cmd = args[0] || 'show';
        
        if (cmd === 'show') {
          println('=== Terminal Notes 配置概览 ===');
          println('');
          
          // 环境变量部分
          println('🔧 环境变量 (Environment Variables):');
          const envEntries = Object.entries(env);
          if (envEntries.length === 0) {
            println('  (无自定义环境变量)');
          } else {
            const maxKeyLen = Math.max(...envEntries.map(([k]) => k.length));
            envEntries.forEach(([k, v]) => {
              const isDefault = defaultEnv[k] === v;
              const status = isDefault ? '[默认]' : '[自定义]';
              const padding = ' '.repeat(maxKeyLen - k.length + 2);
              println(`  ${k}${padding}= ${v} ${status}`);
            });
          }
          println('');
          
          // 别名部分
          println('📛 命令别名 (Aliases):');
          const aliasEntries = Object.entries(aliasMap);
          if (aliasEntries.length === 0) {
            println('  (无自定义别名)');
          } else {
            const maxAliasLen = Math.max(...aliasEntries.map(([k]) => k.length));
            aliasEntries.forEach(([k, v]) => {
              const padding = ' '.repeat(maxAliasLen - k.length + 2);
              println(`  ${k}${padding}= '${v}'`);
            });
          }
          println('');
          
          // 存储信息
          println('💾 数据存储:');
          println('  ✅ 永久保存: 环境变量、别名、主题模式');
          println('  🔄 会话保存: 当前目录、终端历史、命令历史');
          println('');
          
          // 快速设置提示
          println('💡 快速设置示例:');
          println('  export PS1="> "     # 自定义提示符');
          println('  export THEME=amber  # 切换主题');
          println('  export FONTSIZE=18  # 调整字体');
          println('  alias ll="ls -la"   # 设置别名');
          
        } else if (cmd === 'reset') {
          const subCmd = args[1];
          if (subCmd === 'env') {
            // 重置环境变量
            Object.keys(env).forEach(k => {
              if (defaultEnv[k] !== undefined) {
                env[k] = defaultEnv[k];
              } else {
                delete env[k];
              }
            });
            saveJSON(LS_KEYS.env, env);
            applyTheme(env.THEME);
            applyFontSize(env.FONTSIZE);
            renderPrompt();
            println('✅ 环境变量已重置为默认值');
          } else if (subCmd === 'alias') {
            // 重置别名
            Object.keys(aliasMap).forEach(k => delete aliasMap[k]);
            saveJSON(LS_KEYS.alias, aliasMap);
            println('✅ 所有别名已清除');
          } else if (subCmd === 'all') {
            // 重置所有配置
            Object.keys(env).forEach(k => {
              if (defaultEnv[k] !== undefined) {
                env[k] = defaultEnv[k];
              } else {
                delete env[k];
              }
            });
            Object.keys(aliasMap).forEach(k => delete aliasMap[k]);
            saveJSON(LS_KEYS.env, env);
            saveJSON(LS_KEYS.alias, aliasMap);
            applyTheme(env.THEME);
            applyFontSize(env.FONTSIZE);
            renderPrompt();
            println('✅ 所有配置已重置为默认值');
          } else {
            println('用法: config reset [env|alias|all]');
            println('  env   - 重置环境变量');
            println('  alias - 清除所有别名');
            println('  all   - 重置所有配置');
          }
        } else {
          println('用法: config [show|reset]');
          println('  show  - 显示所有配置 (默认)');
          println('  reset - 重置配置');
        }
      },
    },
  };

  // 注册到全局命令系统
  if (window.TerminalCommands) {
    window.TerminalCommands.registerAll(configCommands);
  }
})();
