/**
 * CLI 表现层 UI 工具（第 4 期 · S-09 / S-10）
 *
 * 职责边界：只做终端展示，不承载业务逻辑、不打印 Key、不外发数据（安全红线）。
 * 依赖：boxen / chalk / figlet / log-symbols / ora（已入 dependencies，CR-017 已记录）。
 * inquirer v14 为 ESM-only，按 S-09 要求使用 await import('inquirer') 动态加载。
 * 注意：本项目 tsconfig 为 CJS 产物，Node 24 原生支持 require(esm)，静态导入可直接使用；
 *       仅 inquirer 按规格走动态导入（其余包同样为 ESM，运行时由 require(esm) 桥接）。
 */
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import figlet from 'figlet';
import logSymbols from 'log-symbols';

/** 分级日志：info / success / warn / error / debug / title */
export const logger = {
  info: (msg: string): void => console.log(chalk.cyan(`${logSymbols.info} ${msg}`)),
  success: (msg: string): void => console.log(chalk.green(`${logSymbols.success} ${msg}`)),
  warn: (msg: string): void => console.log(chalk.yellow(`${logSymbols.warning} ${msg}`)),
  error: (msg: string): void => console.log(chalk.red(`${logSymbols.error} ${msg}`)),
  debug: (msg: string): void => console.log(chalk.gray(`${logSymbols.info} ${msg}`)),
  title: (msg: string): void => console.log(chalk.bold.blue(`\n📌 ${msg}\n`)),
};

/** 启动横幅：figlet 'Small' + 版本行（持续对话模式与全局命令入口二选一接入，避免每次刷屏） */
export function showBanner(version: string): void {
  const art = figlet.textSync('ThatPerson', { font: 'Small' });
  console.log(chalk.cyan(art));
  console.log(chalk.gray(`  版本: v${version}  |  个人管家\n`));
}

/** 状态卡片：boxen 圆角蓝边卡片（title + 键值对） */
export function showStatusCard(title: string, lines: Record<string, string>): void {
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
    }),
  );
}

/** 加载动画（用于长时间操作；返回受控句柄，不接管业务逻辑） */
export function startSpinner(text: string): {
  succeed: (msg?: string) => void;
  fail: (msg?: string) => void;
  stop: () => void;
  text: (newText: string) => void;
} {
  const spinner = ora({ text, color: 'cyan' }).start();
  return {
    succeed: (msg?: string): void => {
      spinner.succeed(msg ?? '完成');
    },
    fail: (msg?: string): void => {
      spinner.fail(msg ?? '失败');
    },
    stop: (): void => {
      spinner.stop();
    },
    text: (newText: string): void => {
      spinner.text = newText;
    },
  };
}

/** 交互式问答：inquirer v14 ESM-only，动态导入（S-09） */
export async function ask(
  message: string,
  type: 'input' | 'confirm' = 'input',
): Promise<string | boolean> {
  const { default: inquirer } = await import('inquirer');
  if (type === 'confirm') {
    const answers = (await inquirer.prompt([
      { type: 'confirm' as const, name: 'result', message },
    ])) as { result: boolean };
    return answers.result;
  }
  const answers = (await inquirer.prompt([
    { type: 'input' as const, name: 'result', message },
  ])) as { result: string };
  return answers.result;
}
