/**
 * CLI 内核测试（第 4 期 · S-01/S-02/S-05/S-10/S-18）
 * 覆盖：全局参数解析（--version/--help/--mock/--input-file）、内部指令表行为、
 *       指令-执行-返回（/check directory、自然语言意图）、status 全局指令真实数据、
 *       --version/--help 子进程退出行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseArgs,
  formatHelp,
  formatHistory,
  resetSession,
  saveSessionSnapshot,
  detectToolIntent,
  runTool,
  runGlobalCommand,
  sumArchiveEntries,
  type SessionState,
} from '../src/cli';
import type { ChatMessage } from '../src/chat';
import { isolateHome } from './helpers';

const execFileP = promisify(execFile);
const iso = isolateHome();
test.after(() => iso.restore());

const pkgVersion = (JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSession(history: Array<[string, string]>): SessionState {
  const msgs: ChatMessage[] = history.flatMap(([u, a]) => [
    { role: 'user', content: u },
    { role: 'assistant', content: a },
  ]);
  return { history: msgs, summary: '', recentUserTexts: [] };
}

async function withCapturedLog(fn: () => Promise<unknown>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs;
}

// ===== 全局参数解析（S-01）=====

test('parseArgs：--version / -V 触发版本退出', () => {
  const a = parseArgs(['node', 'cli.js', '--version']);
  assert.equal(a.showVersion, true);
  assert.equal(a.command, null);
  const b = parseArgs(['node', 'cli.js', '-V']);
  assert.equal(b.showVersion, true);
});

test('parseArgs：--help / -h 触发帮助退出', () => {
  assert.equal(parseArgs(['node', 'cli.js', '--help']).showHelp, true);
  assert.equal(parseArgs(['node', 'cli.js', '-h']).showHelp, true);
});

test('parseArgs：--mock 保留离线语义，且不影响其他参数', () => {
  const a = parseArgs(['node', 'cli.js', '--mock']);
  assert.equal(a.isMock, true);
  assert.equal(a.command, null);
  const b = parseArgs(['node', 'cli.js', 'status', '--mock']);
  assert.equal(b.isMock, true);
  assert.equal(b.command, 'status');
});

test('parseArgs：无参数 → 进入持续对话（command 为空）', () => {
  const a = parseArgs(['node', 'cli.js']);
  assert.equal(a.command, null);
  assert.equal(a.showVersion, false);
  assert.equal(a.showHelp, false);
  assert.equal(a.isMock, false);
});

test('parseArgs：--input-file 解析（含 --input-file= 形式）', () => {
  const a = parseArgs(['node', 'cli.js', '--input-file', 'C:\\x\\prompt.txt']);
  assert.equal(a.inputFile, 'C:\\x\\prompt.txt');
  const b = parseArgs(['node', 'cli.js', '--input-file=C:\\x\\p.txt', '--mock']);
  assert.equal(b.inputFile, 'C:\\x\\p.txt');
  assert.equal(b.isMock, true);
});

test('parseArgs：未知参数被收集（未知 flag / 缺值的 --input-file）', () => {
  const a = parseArgs(['node', 'cli.js', '--bogus']);
  assert.deepEqual(a.unknownArgs, ['--bogus']);
  const b = parseArgs(['node', 'cli.js', '--input-file']);
  assert.deepEqual(b.unknownArgs, ['--input-file']);
});

test('parseArgs：子命令与其参数', () => {
  const a = parseArgs(['node', 'cli.js', 'memory', 'stats']);
  assert.equal(a.command, 'memory');
  assert.deepEqual(a.commandArgs, ['stats']);
});

// ===== 内部指令（S-02）=====

test('formatHelp：包含全部内部指令与全局参数/指令', () => {
  const help = formatHelp();
  for (const cmd of ['/help', '/history', '/clear', '/reset', '/exit', '/save', '/update']) {
    assert.ok(help.includes(cmd), `帮助应包含 ${cmd}`);
  }
  for (const flag of ['--version', '--help', '--mock', '--input-file', 'status', 'update']) {
    assert.ok(help.includes(flag), `帮助应包含 ${flag}`);
  }
});

test('formatHistory：消息数与最近 2 轮摘要', () => {
  const session = makeSession([
    ['第一轮你好', '你好呀'],
    ['第二轮咖啡', '好的'],
    ['第三轮跑步', '加油'],
  ]);
  const text = formatHistory(session.history);
  assert.ok(text.includes('当前会话共有 6 条消息。'));
  assert.ok(text.includes('最近 2 轮：'));
  assert.ok(text.includes('第二轮咖啡'));
  assert.ok(text.includes('第三轮跑步'));
  assert.ok(!text.includes('第一轮你好'), '超过 2 轮的内容不应出现在摘要');
});

test('formatHistory：空会话', () => {
  const text = formatHistory([]);
  assert.ok(text.includes('0 条消息'));
});

test('resetSession：清空历史/摘要/近期输入三处', () => {
  const session = makeSession([['你好', '你好']]);
  session.summary = '旧摘要';
  session.recentUserTexts.push('你好');
  resetSession(session);
  assert.equal(session.history.length, 0);
  assert.equal(session.summary, '');
  assert.equal(session.recentUserTexts.length, 0);
});

test('saveSessionSnapshot：写入 history/sessions/ 且不覆盖同名文件', () => {
  const historyDir = path.join(tmpDir('thatperson-snap-'), 'history');
  const session = makeSession([['你好', '你好呀']]);
  const file1 = saveSessionSnapshot(session, historyDir);
  assert.ok(fs.existsSync(file1), '快照文件应存在');
  assert.ok(path.basename(file1).startsWith('session-'), '快照文件名应以 session- 开头');
  assert.ok(path.dirname(file1).endsWith('sessions'), '快照应落在 history/sessions/');
  const content1 = fs.readFileSync(file1, 'utf8');
  assert.ok(content1.includes('消息数：2'));
  assert.ok(content1.includes('**用户**：你好'));
  assert.ok(content1.includes('**ThatPerson**：你好呀'));
  // 再次保存：不得覆盖已有文件（同名冲突时追加序号）
  const before1 = fs.readFileSync(file1, 'utf8');
  const file2 = saveSessionSnapshot(session, historyDir);
  assert.notEqual(file1, file2);
  assert.ok(fs.existsSync(file2));
  assert.equal(fs.readFileSync(file1, 'utf8'), before1, '已有快照内容不应被覆盖');
});

// ===== 指令-执行-返回（S-05）=====

test('detectToolIntent：自然语言「检查工作目录」识别为 check directory', () => {
  assert.deepEqual(detectToolIntent('检查工作目录'), { command: 'check', args: 'directory' });
  assert.deepEqual(detectToolIntent('帮我看看当前目录'), { command: 'check', args: 'directory' });
  assert.deepEqual(detectToolIntent('列出目录内容'), { command: 'check', args: 'directory' });
});

test('detectToolIntent：普通聊天不误触发', () => {
  assert.equal(detectToolIntent('今天天气不错'), null);
  assert.equal(detectToolIntent(''), null);
});

test('runTool：check directory 真实列出目录内容', async () => {
  const dir = tmpDir('thatperson-tool-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a', 'utf8');
  fs.mkdirSync(path.join(dir, 'sub'));
  const result = await runTool('check', 'directory', dir);
  assert.ok(result.includes(`目录 ${dir} 下共 2 项`));
  assert.ok(result.includes('a.txt'));
  assert.ok(result.includes('sub/'));
});

test('runTool：未知指令返回诚实拒绝文本', async () => {
  const result = await runTool('unknown', 'x', tmpDir('thatperson-tool-'));
  assert.ok(result.includes('没有可执行的指令'));
});

test('runTool：不支持的检查项返回边界说明', async () => {
  const result = await runTool('check', 'file', tmpDir('thatperson-tool-'));
  assert.ok(result.includes('暂不支持该检查项'));
});

// ===== status 全局指令（S-10 真实数据）=====

test('runGlobalCommand(status)：输出真实数据状态卡片（无占位示例）', async () => {
  process.env.THATPERSON_MEMORY_DIR = path.join(iso.home, 'history');
  try {
    const logs = await withCapturedLog(() => runGlobalCommand('status', []));
    const output = logs.join('\n');
    assert.ok(output.includes('📊 系统状态'));
    assert.ok(output.includes('版本'));
    assert.ok(output.includes('模型'));
    assert.ok(output.includes('记忆条目'));
    assert.ok(output.includes('技能数量'));
    assert.ok(output.includes('Token 预算'));
    assert.ok(output.includes('工作目录'));
    assert.ok(output.includes('全局目录'));
    assert.ok(output.includes('deepseek-v4-flash'), '默认模型应来自 loadConfig()');
    assert.ok(output.includes(pkgVersion), '版本应来自 package.json');
  } finally {
    delete process.env.THATPERSON_MEMORY_DIR;
  }
});

test('runGlobalCommand(help)：打印帮助并返回 0', async () => {
  const logs = await withCapturedLog(() => runGlobalCommand('help', []));
  assert.ok(logs.join('\n').includes('ThatPerson CLI 帮助'));
});

test('runGlobalCommand(update)：本地开发路径跳过更新检查', async () => {
  const logs = await withCapturedLog(() => runGlobalCommand('update', []));
  assert.ok(logs.some((l) => l.includes('跳过更新检查')));
});

test('runGlobalCommand：未知子命令 → 提示 + 帮助 + 退出码 1', async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(' '));
  };
  let code = -1;
  try {
    code = await runGlobalCommand('bogus', []);
  } finally {
    console.log = original;
  }
  assert.equal(code, 1);
  assert.ok(logs.some((l) => l.includes('未知命令：thatperson bogus')));
  assert.ok(logs.join('\n').includes('/help'));
});

// ===== 记忆统计（S-10 数据源）=====

test('sumArchiveEntries：统计各分区归档条目数之和', () => {
  const historyDir = path.join(tmpDir('thatperson-sum-'), 'history');
  fs.mkdirSync(path.join(historyDir, 'profile'), { recursive: true });
  fs.mkdirSync(path.join(historyDir, 'experiences'), { recursive: true });
  fs.writeFileSync(
    path.join(historyDir, 'profile', 'preferences.md'),
    '## 2026-08-11\n\n### [归档类型：偏好]\n- **原始对话片段**：<dialog>"a"</dialog>\n\n### [归档类型：偏好]\n- **原始对话片段**：<dialog>"b"</dialog>\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(historyDir, 'experiences', 'journal.md'),
    '## 2026-08-10\n\n### [归档类型：经历]\n- **原始对话片段**：<dialog>"c"</dialog>\n',
    'utf8',
  );
  assert.equal(sumArchiveEntries(historyDir), 3);
});

// ===== --version / --help 子进程退出行为（S-01 判据）=====

const CLI_JS = path.resolve(__dirname, '..', 'src', 'cli.js');

test('子进程：node cli.js --version 输出版本后退出（不再进入对话）', async () => {
  const { stdout } = await execFileP(process.execPath, [CLI_JS, '--version']);
  assert.equal(stdout.trim(), pkgVersion);
});

test('子进程：node cli.js -V 等价输出版本', async () => {
  const { stdout } = await execFileP(process.execPath, [CLI_JS, '-V']);
  assert.equal(stdout.trim(), pkgVersion);
});

test('子进程：node cli.js --help 打印内部 + 全局帮助后退出', async () => {
  const { stdout } = await execFileP(process.execPath, [CLI_JS, '--help']);
  assert.ok(stdout.includes('ThatPerson CLI 帮助'));
  assert.ok(stdout.includes('/help'));
  assert.ok(stdout.includes('status'));
});