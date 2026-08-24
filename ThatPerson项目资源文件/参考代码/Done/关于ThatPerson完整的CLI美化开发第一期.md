## CLI 界面美化（UI 工具包）参考代码

> 来源：BUCISHUI 第四版提示词原稿「优化CLI界面」节。
> **性质：仅作参考，需按项目实际适配**。原文标注「已安装相关依赖」——`boxen / chalk / figlet / inquirer / log-symbols / ora` 已装入 `package.json` 的 `dependencies`；`commander`（下方 cli.ts 示例用到）**尚未安装**，若走 commander 方案须先经供应链评审后安装，否则改手写 `process.argv` 解析。
> 关联：`CLI生态相关\指令相关\关于ThatPerson完整的CLI生态开发第一期.md`（内部/全局指令参考）；交付物见优化版提示词第 10 项（`CLI生态相关\CLI界面优化相关\` 报告）。

### 1. 创建 src/utils/ui.ts（封装全部 UI 样式）

```typescript
// src/utils/ui.ts
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import figlet from 'figlet';
import logSymbols from 'log-symbols';

// 1. 日志分级（带颜色和图标）
export const logger = {
  info: (msg: string) => console.log(chalk.cyan(`ℹ️  ${msg}`)),
  success: (msg: string) => console.log(chalk.green(`✅ ${msg}`)),
  warn: (msg: string) => console.log(chalk.yellow(`⚠️  ${msg}`)),
  error: (msg: string) => console.log(chalk.red(`❌ ${msg}`)),
  debug: (msg: string) => console.log(chalk.gray(`🐞 ${msg}`)),
  title: (msg: string) => console.log(chalk.bold.blue(`\n📌 ${msg}\n`)),
};

// 2. 启动横幅（ASCII 艺术字 + 版本）
export const showBanner = (version: string) => {
  const art = figlet.textSync('ThatPerson', { font: 'Small' });
  console.log(chalk.cyan(art));
  console.log(chalk.gray(`  版本: v${version}  |  个人管理与陪伴 Agent\n`));
};

// 3. 状态卡片（适合展示记忆、配置、检查结果）
export const showStatusCard = (title: string, lines: Record<string, string>) => {
  const content = Object.entries(lines)
    .map(([key, value]) => `${chalk.bold(key)}: ${value}`)
    .join('\n');
  console.log(
    boxen(content, {
      title: ` ${title} `,
      titleAlignment: 'center',
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'blue',
    })
  );
};

// 4. 加载动画（用于长时间操作）
export const startSpinner = (text: string) => {
  const spinner = ora({ text, color: 'cyan' }).start();
  return {
    succeed: (msg?: string) => spinner.succeed(msg || '完成'),
    fail: (msg?: string) => spinner.fail(msg || '失败'),
    stop: () => spinner.stop(),
    text: (newText: string) => (spinner.text = newText),
  };
};

// 5. 交互式问答（简单封装）
export const ask = async (message: string, type: 'input' | 'confirm' = 'input') => {
  const { default: inquirer } = await import('inquirer');
  if (type === 'confirm') {
    const answer = await inquirer.prompt([{ type: 'confirm', name: 'result', message }]);
    return answer.result;
  }
  const answer = await inquirer.prompt([{ type: 'input', name: 'result', message }]);
  return answer.result;
};
```

### 2. 更新 cli.ts（接入 UI 工具包）

```typescript
#!/usr/bin/env node

import { program } from 'commander';
import { showBanner, logger, showStatusCard, startSpinner } from './utils/ui';
import packageJson from '../package.json';

// 1. 启动时显示横幅和版本
showBanner(packageJson.version);

// 2. 定义 `thatperson status` 命令（展示漂亮的卡片）
program
  .command('status')
  .description('查看 ThatPerson 系统状态')
  .action(async () => {
    logger.info('正在收集系统状态...');
    
    // 模拟加载
    const spinner = startSpinner('读取记忆库...');
    await new Promise((resolve) => setTimeout(resolve, 500));
    spinner.succeed('读取完成');

    // 展示状态卡片（类似 Claude Code 的界面）
    showStatusCard('📊 系统状态', {
      '版本': packageJson.version,
      '记忆条目': '42 条',
      '技能数量': '3 个',
      'Token 预算': '6000 / 轮',
      '工作目录': process.cwd(),
    });

    logger.success('状态检查完毕');
  });

// 3. 处理未知命令
program
  .command('*', { isDefault: true })
  .action(() => {
    logger.warn('未知命令，请输入 --help 查看可用指令');
  });

program.parse();
```

### 3. 参考注意点

- 状态卡片中的记忆条目/技能数量是**占位示例**（42 条 / 3 个），落地时需接真实数据：`store.load()` 统计 + `listSkills().length`。
- `showBanner` 在持续对话模式（`npm run chat`）与全局命令入口二选一的位置接入，避免每次对话都刷横幅。
- 所有封装遵循安全红线：不打印 Key、不外发数据；UI 层只做展示，不承载业务逻辑。
