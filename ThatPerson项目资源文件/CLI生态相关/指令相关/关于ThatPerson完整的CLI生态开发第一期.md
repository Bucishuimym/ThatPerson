## Agent内部指令

```typescript
// cli.ts 中新增命令处理逻辑

const commands: Record<string, (args?: string) => void> = {
  '/help': () => {
    console.log(`\n可用命令：
  /help        - 显示此帮助信息
  /history     - 查看当前会话历史
  /clear       - 清空终端屏幕
  /reset       - 重置当前会话（清空历史）
  /exit        - 退出程序
  /save        - 将当前会话保存到 history/ 目录\n`)
  },
  '/history': () => {
    console.log(`\n当前会话共有 ${history.length} 条消息。`)
    // 可展示最近几条
  },
  '/clear': () => {
    console.clear()
  },
  '/reset': () => {
    history.length = 0  // 清空数组
    console.log('会话已重置。')
  },
  '/exit': () => {
    console.log('再见 👋')
    process.exit(0)
  },
}

// 在 while 循环中，读到用户输入后优先检查是否是命令
while (true) {
  const input = await rl.question('你: ')
  if (input.startsWith('/')) {
    const [cmd, ...args] = input.split(' ')
    if (commands[cmd]) {
      commands[cmd](args.join(' '))
    } else {
      console.log(`未知命令: ${cmd}，输入 /help 查看可用命令。`)
    }
    continue  // 不把命令发给模型
  }
  // 正常对话逻辑...
}
```

## CLI全局指令

```typescript
#!/usr/bin/env node

import { Command } from 'commander';  // 推荐用 commander 库
// 或者你自己解析 process.argv

const program = new Command();

program
  .name('thatperson')
  .description('ThatPerson - 个人管理与陪伴 Agent')
  .version('1.0.0');

// 子命令：status
program
  .command('status')
  .description('显示系统状态')
  .action(() => {
    // 读取 config、memory stats 等
    console.log('📊 ThatPerson 状态');
    console.log('  - 记忆条目: 42');
    console.log('  - 技能数量: 3');
    console.log('  - 配置: ~/.thatperson/config.json');
  });

// 子命令：memory search
program
  .command('search <keyword>')
  .description('在记忆中搜索关键词')
  .action((keyword) => {
    // 调用 searchMemory(keyword)
    console.log(`🔍 搜索 "${keyword}" 的结果：`);
    // 输出匹配的记忆条目
  });

// 子命令：memory stats
program
  .command('memory')
  .description('记忆管理')
  .command('stats')
  .description('显示记忆统计')
  .action(() => {
    // 统计记忆数量、分类、最近归档等
  });

program.parse();
```

#### 可参考以下指令分类
```markdown
The user wants me to convert the given text about thatperson commands into a markdown table format.
| 分类 | 指令示例 | 作用 |
|------|----------|------|
| **系统状态** | `thatperson status` | 显示当前配置、记忆数量、token 预算等 |
| **记忆管理** | `thatperson memory stats` | 显示记忆库统计信息 |
| | `thatperson memory clean` | 清理过期/低置信度记忆 |
| | `thatperson memory search "关键词"` | 在记忆库中搜索 |
| **知识库** | `thatperson kb list` | 列出已加载的知识库文件 |
| | `thatperson kb sync` | 重新扫描知识库 |
| **会话** | `thatperson session list` | 列出历史会话 |
| | `thatperson session clear` | 清空当前会话 |
| **配置** | `thatperson config get` | 查看当前配置 |
| | `thatperson config set <key> <value>` | 修改配置 |
| **技能** | `thatperson skills list` | 列出已安装技能 |
| | `thatperson skills enable <name>` | 启用技能 |
| | `thatperson skills disable <name>` | 禁用技能 |
```
