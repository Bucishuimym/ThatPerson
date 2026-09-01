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
  configGetText,
  configSetText,
  sumArchiveEntries,
  memorySearchText,
  type SessionState,
} from '../src/cli';
import type { ChatMessage } from '../src/chat';
import { ensureConfigDir } from '../src/config';
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

test('parseArgs：--dir 透传到 commandArgs（export 用，不作为未知参数）', () => {
  const a = parseArgs(['node', 'cli.js', 'export', '--dir', 'out/x']);
  assert.equal(a.command, 'export');
  assert.deepEqual(a.commandArgs, ['--dir', 'out/x']);
  assert.deepEqual(a.unknownArgs, []);
  const eq = parseArgs(['node', 'cli.js', 'export', '--dir=out/y']);
  assert.deepEqual(eq.commandArgs, ['--dir=out/y']);
  const missing = parseArgs(['node', 'cli.js', 'export', '--dir']);
  assert.ok(missing.unknownArgs.includes('--dir'), '缺值的 --dir 应记为未知参数');
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

test('saveSessionSnapshot：frontmatter 头 + index.json 登记（KS-42）', () => {
  const historyDir = path.join(tmpDir('thatperson-snap-fm-'), 'history');
  const session = makeSession([['你好，我想聊传统拿铁', '好的，记住了']]);
  session.summary = '早期摘要：喜欢传统拿铁';
  const file = saveSessionSnapshot(session, historyDir);

  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /^---\nid: session_\d{8}_\d{6}\n/, '快照应以 frontmatter 开头且含 id');
  assert.match(content, /^title: 你好，我想聊传统拿铁$/m, 'title 取首条用户消息前 20 字');
  assert.match(content, /^created_at: .+T.+$/m, '应含 ISO created_at');
  assert.match(content, /^updated_at: .+T.+$/m, '应含 ISO updated_at');
  assert.match(content, /^summary: 早期摘要：喜欢传统拿铁$/m, '应含 summary');
  assert.ok(content.includes('# 会话快照 · '), '既有正文格式应保留');
  assert.ok(content.includes('**用户**：你好，我想聊传统拿铁'), '消息行断言不回归');

  const indexPath = path.join(historyDir, 'sessions', 'index.json');
  assert.ok(fs.existsSync(indexPath), 'index.json 应被创建');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
    version: number;
    sessions: Array<{ id: string; title: string; created_at: string; file: string }>;
  };
  assert.equal(index.version, 1);
  assert.equal(index.sessions.length, 1);
  assert.equal(index.sessions[0].file, path.basename(file), '索引 file 应指向快照文件');
  assert.match(index.sessions[0].id, /^session_\d{8}_\d{6}$/);

  // 再次保存：索引 upsert 不重复，两个快照都在
  const file2 = saveSessionSnapshot(session, historyDir);
  const index2 = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { sessions: Array<{ id: string; file: string }> };
  assert.equal(index2.sessions.length, 2, '同秒冲突时应各自登记，不重复覆盖');
  const files = index2.sessions.map((s) => s.file);
  assert.ok(files.includes(path.basename(file)) && files.includes(path.basename(file2)), '两个快照都应在索引中');
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

test('runGlobalCommand(update)：THATPERSON_DEV=true 时跳过更新检查', async () => {
  const saved = process.env.THATPERSON_DEV;
  process.env.THATPERSON_DEV = 'true';
  try {
    const logs = await withCapturedLog(() => runGlobalCommand('update', []));
    assert.ok(logs.some((l) => l.includes('跳过更新检查')));
  } finally {
    if (saved === undefined) delete process.env.THATPERSON_DEV;
    else process.env.THATPERSON_DEV = saved;
  }
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

// ===== 批次一：setup/reset/present/config 掩码（KS-7~13）=====

/** 在独立临时 HOME 中执行 fn（避免污染模块级 iso.home） */
async function withTempHome(fn: () => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-cli5-'));
  const saved = process.env.THATPERSON_HOME;
  process.env.THATPERSON_HOME = home;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.THATPERSON_HOME;
    else process.env.THATPERSON_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('formatHelp：包含批次一新指令（setup/wizard/reset/present init/show）', () => {
  const help = formatHelp();
  assert.ok(help.includes('setup'), '帮助应含 setup');
  assert.ok(help.includes('wizard'), '帮助应含 wizard 别名');
  assert.ok(help.includes('reset'), '帮助应含 reset');
  assert.ok(help.includes('present init'), '帮助应含 present init');
  assert.ok(help.includes('present show'), '帮助应含 present show');
  assert.ok(help.includes('apiKey'), '帮助应提到 apiKey 配置键');
});

test('configGetText / configSetText：apiKey 掩码回显且不泄漏明文（KS-10）', async () => {
  await withTempHome(async () => {
    const setText = configSetText('apiKey', 'sk-test1234abcd');
    assert.ok(setText.includes('sk-***abcd'), `set 回显应掩码，实际：${setText}`);
    assert.ok(!setText.includes('sk-test1234abcd'), 'set 回显不得含明文 Key');
    const getText = configGetText('apiKey');
    assert.ok(getText.includes('sk-***abcd'), `get 应掩码，实际：${getText}`);
    assert.ok(!getText.includes('sk-test1234abcd'), 'get 不得含明文 Key');
    const fullText = configGetText();
    assert.ok(fullText.includes('API Key：sk-***abcd'), '全量输出应掩码');
    assert.ok(!fullText.includes('sk-test1234abcd'), '全量输出不得含明文 Key');
  });
});

test('runGlobalCommand(reset)：保留 apiKey/model/allowedDirs，清 disabledSkills、configured 置 false', async () => {
  await withTempHome(async () => {
    const { configPath } = ensureConfigDir();
    fs.writeFileSync(
      configPath,
      JSON.stringify({ model: 'test-model', disabledSkills: ['code-op'], apiKey: 'sk-test1234abcd', configured: true, allowedDirs: ['D:\\granted-test'] }, null, 2),
      'utf8',
    );
    await withCapturedLog(() => runGlobalCommand('reset', []));
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(cfg.model, 'test-model');
    assert.equal(cfg.apiKey, 'sk-test1234abcd');
    assert.equal(cfg.disabledSkills, undefined, 'reset 后应清除 disabledSkills');
    assert.equal(cfg.configured, false, 'reset 后显式写 configured:false（批次二契约）');
    assert.ok(Array.isArray(cfg.allowedDirs) && cfg.allowedDirs.includes('D:\\granted-test'), 'reset 后应保留 allowedDirs');
  });
});

test('runGlobalCommand(present init/show)：模板落盘不覆盖既有文件（KS-13）', async () => {
  await withTempHome(async () => {
    const logs = await withCapturedLog(() => runGlobalCommand('present', ['init']));
    const output = logs.join('\n');
    assert.ok(output.includes('已生成人格模板'), `应生成模板，实际：${output}`);
    const home = process.env.THATPERSON_HOME as string;
    const presentDir = path.join(home, 'present');
    const files = fs.readdirSync(presentDir).filter((f) => f.endsWith('.md'));
    assert.ok(files.length >= 3, `应生成多个人格模板，实际：${files.join(',')}`);
    // 二次 init 不覆盖
    const before = fs.readFileSync(path.join(presentDir, files[0]), 'utf8');
    const logs2 = await withCapturedLog(() => runGlobalCommand('present', ['init']));
    assert.ok(logs2.join('\n').includes('已存在未覆盖'));
    assert.equal(fs.readFileSync(path.join(presentDir, files[0]), 'utf8'), before, '二次 init 不得覆盖既有文件');
    // present show 输出当前生效人格
    const showLogs = await withCapturedLog(() => runGlobalCommand('present', ['show']));
    assert.ok(showLogs.join('\n').length > 0);
  });
});

test('runGlobalCommand(export/import)：导出包生成 → 新 home 导入 → memory search 命中（KS-45/KS-46）', async () => {
  let pkgRoot = '';
  // 源 home：造记忆资产并导出
  await withTempHome(async () => {
    const home = process.env.THATPERSON_HOME as string;
    fs.mkdirSync(path.join(home, 'history', 'profile'), { recursive: true });
    fs.mkdirSync(path.join(home, 'present'), { recursive: true });
    fs.writeFileSync(path.join(home, 'history', 'profile', 'preferences.md'), '## 偏好\n传统拿铁\n', 'utf8');
    fs.writeFileSync(path.join(home, 'present', 'identity.md'), '# 身份\n热爱编程\n', 'utf8');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-exp-out-'));
    const logs = await withCapturedLog(() => runGlobalCommand('export', ['--dir', outDir]));
    const out = logs.join('\n');
    assert.ok(out.includes('已导出记忆到'), `应输出导出目录，实际：${out}`);
    assert.ok(!out.includes('apiKey'), '导出输出不得打印 Key 字段');
    const pkg = fs.readdirSync(outDir).find((d) => d.startsWith('thatperson-export-'));
    assert.ok(pkg, '应生成 thatperson-export-<时间戳> 包');
    pkgRoot = path.join(outDir, pkg as string);
    assert.ok(fs.existsSync(path.join(pkgRoot, 'manifest.json')), '应含 manifest.json');
  });
  assert.ok(pkgRoot, '前置：导出成功');
  // 新 home：导入并检索
  await withTempHome(async () => {
    const logs = await withCapturedLog(() => runGlobalCommand('import', [pkgRoot]));
    const out = logs.join('\n');
    assert.ok(out.includes('已导入'), `应打印导入数，实际：${out}`);
    const home = process.env.THATPERSON_HOME as string;
    assert.ok(fs.existsSync(path.join(home, 'history', 'profile', 'preferences.md')), '导入后记忆文件应存在');
    assert.ok(
      memorySearchText(path.join(home, 'history'), '拿铁').includes('拿铁'),
      'import 后 memory search 应命中',
    );
  });
});

test('子进程：node cli.js --version 后主目录自动生成（KS-7）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-ver-'));
  const env = { ...process.env, THATPERSON_HOME: home };
  try {
    const { stdout } = await execFileP(process.execPath, [CLI_JS, '--version'], { env });
    assert.equal(stdout.trim(), pkgVersion);
    assert.ok(fs.existsSync(path.join(home, 'config.json')), '应生成 config.json');
    for (const sub of ['present', 'skills', 'logs', 'history']) {
      assert.ok(fs.existsSync(path.join(home, sub)), `应生成 ${sub}/ 目录`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
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

// ===== 批次二：web / open 全局指令解析层（KS-7.26 / T6·T8，指令接线前红）=====

test('parseArgs：web 指令 --port/--no-open 透传到 commandArgs（不记为未知参数）', () => {
  const a = parseArgs(['node', 'cli.js', 'web', '--port', '4321', '--no-open']);
  assert.equal(a.command, 'web');
  assert.deepEqual(a.commandArgs, ['--port', '4321', '--no-open']);
  assert.deepEqual(a.unknownArgs, []);
  const b = parseArgs(['node', 'cli.js', 'web']);
  assert.equal(b.command, 'web');
  assert.deepEqual(b.commandArgs, []);
  const eq = parseArgs(['node', 'cli.js', 'web', '--port=4321']);
  assert.deepEqual(eq.commandArgs, ['--port=4321']);
  assert.deepEqual(eq.unknownArgs, []);
  const missing = parseArgs(['node', 'cli.js', 'web', '--port']);
  assert.ok(missing.unknownArgs.includes('--port'), '缺值的 --port 应记为未知参数');
});

test('parseArgs：open 指令取目录参数', () => {
  const a = parseArgs(['node', 'cli.js', 'open', 'D:\\notes']);
  assert.equal(a.command, 'open');
  assert.deepEqual(a.commandArgs, ['D:\\notes']);
  assert.deepEqual(a.unknownArgs, []);
});

test('runGlobalCommand(open)：合法目录授权成功（退出码 0 且 allowedDirs 持久化）', async () => {
  await withTempHome(async () => {
    ensureConfigDir();
    const dir = tmpDir('thatperson-open-ok-');
    let code = -1;
    const logs = await withCapturedLog(async () => {
      code = await runGlobalCommand('open', [dir]);
    });
    assert.equal(code, 0, `open 合法目录应返回 0，实际 ${code}；输出：${logs.join('\n')}`);
    const cfgPath = path.join(process.env.THATPERSON_HOME as string, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { allowedDirs?: string[] };
    assert.ok(
      Array.isArray(cfg.allowedDirs) && cfg.allowedDirs.some((d) => path.resolve(d) === path.resolve(dir)),
      'open 应复用 allowDir 持久化授权到 allowedDirs',
    );
  });
});

test('runGlobalCommand(open)：目录不存在拒绝（退出码 1 且不写入 allowedDirs）', async () => {
  await withTempHome(async () => {
    ensureConfigDir();
    const bogus = path.join(os.tmpdir(), `thatperson-open-missing-${Date.now()}`);
    let code = -1;
    await withCapturedLog(async () => {
      code = await runGlobalCommand('open', [bogus]);
    });
    assert.equal(code, 1, '不存在的目录应拒绝（退出码 1）');
    const cfgPath = path.join(process.env.THATPERSON_HOME as string, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { allowedDirs?: string[] };
    const added = Array.isArray(cfg.allowedDirs) && cfg.allowedDirs.some((d) => path.resolve(d) === path.resolve(bogus));
    assert.ok(!added, '拒绝时不得写入 allowedDirs');
  });
});