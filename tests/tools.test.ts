/**
 * 工具层与 ReAct 循环测试（第 5 期批次二 · KS-16 ~ KS-20 / KS-22）
 *
 * 覆盖面：
 * - KS-17 注册表白名单（≥5 个 read/write 工具）、未注册拒绝 unknown-tool、run_shell 默认不注册
 * - KS-18 参数校验（必填缺失/类型错误/enum 拒绝）、路径穿越拒绝（../、白名单外、符号链接）、结果截断
 * - KS-22 read_vault_note / search_vault / append_memory / edit_present 正常路径
 * - KS-20 loop 三段（解析→执行→回灌→再推理）、5 轮上限、失败重试→成功、连续失败→认输
 *
 * 全部离线：不调用 API、不读写 .env / API-key.md；工具与循环均以 node:test 驱动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildToolSpecs,
  isRegistered,
  listTools,
  registerTool,
  unregisterTool,
} from '../src/tools/registry';
import { assertPathAllowed, truncateResult, RESULT_CHAR_LIMIT } from '../src/tools/guards';
import { executeTool } from '../src/tools/executor';
import { registerBuiltins } from '../src/tools/builtin';
import { runAgentLoop, MAX_TOOL_ITERATIONS, type ToolLogEntry } from '../src/agent/loop';
import type { ToolContext } from '../src/tools/types';
import type { LoadedMemories } from '../src/memory/types';
import { isolateHome } from './helpers';

const iso = isolateHome();
test.after(() => iso.restore());

// 注册内置工具白名单（每测试文件独立进程，无跨文件污染）
registerBuiltins();

const EMPTY_MEMORIES: LoadedMemories = {
  profile: {},
  importantDates: null,
  patterns: null,
  recentSessions: [],
};

function makeTmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCtx(root: string): ToolContext {
  return { cwd: root, home: root, allowedRoots: [root] };
}

/** 在指定目录下执行异步函数，结束后恢复原 cwd */
function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  return fn().finally(() => process.chdir(prev));
}

// ===== 注册表 =====

test('KS-17 注册表白名单：≥5 个 read/write 工具，run_shell 默认不注册', () => {
  const tools = listTools();
  const readWrite = tools.filter((t) => t.policy === 'read' || t.policy === 'write');
  assert.ok(readWrite.length >= 5, `read/write 工具应 ≥5，实际 ${readWrite.length}`);
  for (const name of [
    'list_directory',
    'read_file',
    'read_vault_note',
    'search_vault',
    'search_memory',
    'append_memory',
    'edit_present',
  ]) {
    assert.ok(tools.some((t) => t.name === name), `应注册内置工具：${name}`);
  }
  assert.ok(!tools.some((t) => t.name === 'run_shell'), 'run_shell 默认不应注册');
});

test('KS-17 run_shell 环境变量门控：THATPERSON_ENABLE_SHELL=true 时才注册', () => {
  process.env.THATPERSON_ENABLE_SHELL = 'true';
  try {
    registerBuiltins();
    assert.ok(isRegistered('run_shell'), '开启环境变量后应注册 run_shell');
  } finally {
    delete process.env.THATPERSON_ENABLE_SHELL;
    unregisterTool('run_shell');
  }
  assert.ok(!isRegistered('run_shell'), '清理后 run_shell 应注销');
});

test('KS-17 buildToolSpecs：静态生成精简描述，不含对话/记忆内容', () => {
  const specs = buildToolSpecs(listTools());
  assert.ok(specs.includes('- list_directory(dir:string):'), '应包含精简工具行');
  assert.ok(specs.includes('path:string,必填'), '必填参数应带 ,必填 标记');
  assert.ok(!specs.includes('喜欢'), '清单不得包含对话/记忆内容');
});

test('KS-17 未注册名称拒绝：executeTool 返回 unknown-tool', async () => {
  const root = makeTmpRoot('tp-tools-');
  const result = await executeTool('definitely_not_registered', {}, makeCtx(root));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'unknown-tool');
});

// ===== 执行器 / 守卫 =====

test('KS-18 danger 双门控：未授权拒绝 danger-disabled，授权后放行', async () => {
  const root = makeTmpRoot('tp-tools-');
  registerTool({
    name: 'test_danger',
    description: '测试用危险工具',
    params: [],
    policy: 'danger',
    handler: () => ({ ok: true, content: 'should not run' }),
  });
  try {
    const blocked = await executeTool('test_danger', {}, makeCtx(root), { dangerAllowed: false });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error, 'danger-disabled');
    const allowed = await executeTool('test_danger', {}, makeCtx(root), { dangerAllowed: true });
    assert.deepEqual(allowed, { ok: true, content: 'should not run' });
  } finally {
    unregisterTool('test_danger');
  }
});

test('KS-18 参数校验：必填缺失 / 类型错误 / enum 拒绝', async () => {
  const root = makeTmpRoot('tp-tools-');
  const ctx = makeCtx(root);

  const noInsight = await executeTool('append_memory', { type: '偏好' }, ctx);
  assert.equal(noInsight.ok, false);
  if (!noInsight.ok) assert.ok(noInsight.error.includes('insight'), '缺少必填参数应报错');

  const badType = await executeTool('append_memory', { type: '偏好', insight: 123 }, ctx);
  assert.equal(badType.ok, false);
  if (!badType.ok) assert.ok(badType.error.includes('类型错误'), '类型错误应报错');

  const badEnum = await executeTool('append_memory', { type: '坏类型', insight: 'x' }, ctx);
  assert.equal(badEnum.ok, false);
  if (!badEnum.ok) assert.ok(badEnum.error.includes('不合法'), 'enum 越界应拒绝');
});

test('KS-18 路径穿越拒绝：../ 逃逸、白名单外绝对路径、符号链接', async () => {
  const root = makeTmpRoot('tp-tools-');
  const insideFile = path.join(root, 'inside.txt');
  fs.writeFileSync(insideFile, 'inside', 'utf8');
  const outsideFile = path.join(os.tmpdir(), `tp-outside-${Date.now()}.txt`);
  fs.writeFileSync(outsideFile, 'secret', 'utf8');
  try {
    assert.equal(assertPathAllowed(path.join(root, '..', 'x.txt'), [root]), null, '.. 逃逸应拒绝');
    assert.equal(assertPathAllowed(outsideFile, [root]), null, '白名单外绝对路径应拒绝');
    assert.equal(
      assertPathAllowed(insideFile, [root]),
      fs.realpathSync(insideFile),
      '白名单内路径应放行并返回绝对路径',
    );

    const link = path.join(root, 'evil-link.txt');
    try {
      fs.symlinkSync(outsideFile, link);
    } catch {
      return; // Windows 上符号链接可能受限，受限时跳过
    }
    assert.equal(assertPathAllowed(link, [root]), null, '符号链接指向白名单外应拒绝');
  } finally {
    fs.rmSync(outsideFile, { force: true });
  }
});

// ===== 第 6 期批次二 · 安全与权限（D-4 测试先行，红态契约；src 尚未改造，以下按批次二契约断言） =====
import * as configB2Module from '../src/config';
import type { ToolDef as B2ToolDef } from '../src/tools/types';

/** 结构化拒绝错误码（批次二契约：code 枚举） */
type B2ErrorCode =
  | 'danger-disabled'
  | 'path-denied'
  | 'param-invalid'
  | 'conflict'
  | 'unknown-tool'
  | 'not-found'
  | 'io-error'
  | 'redline-denied'
  | 'other';
/** 风险分级（批次二契约：L0~L3） */
type B2RiskLevel = 'L0' | 'L1' | 'L2' | 'L3';
const B2_ERROR_CODES: readonly B2ErrorCode[] = [
  'danger-disabled',
  'path-denied',
  'param-invalid',
  'conflict',
  'unknown-tool',
  'not-found',
  'io-error',
  'redline-denied',
  'other',
];
const B2_RISK_LEVELS: readonly B2RiskLevel[] = ['L0', 'L1', 'L2', 'L3'];

/** 批次二失败信封：{ ok:false, error, code, riskLevel, reason, unlockHint } */
interface B2Failure {
  ok: false;
  error: string;
  code: B2ErrorCode;
  riskLevel: B2RiskLevel;
  reason: string;
  unlockHint?: string;
}

/** 把当前 ToolResult 断言为批次二结构化结果（编译期类型未就绪，用类型断言兼容） */
function asB2Failure(res: { ok: boolean }): B2Failure {
  return res as B2Failure;
}

/** 批次二 config 授权 API（allowDir/denyDir 尚未实现，经命名空间断言调用） */
type B2DirResult = { ok: true } | { ok: false; error: string };
const configB2 = configB2Module as unknown as {
  allowDir(dir: string): B2DirResult;
  denyDir(dir: string): B2DirResult;
};

/** 清理 config.json 中的 allowedDirs，避免授权跨用例污染 */
function resetAllowedDirs(): void {
  fs.writeFileSync(
    path.join(iso.home, 'config.json'),
    `${JSON.stringify({ model: 'deepseek-v4-flash', disabledSkills: [], configured: false }, null, 2)}\n`,
    'utf8',
  );
}

test('第6期批次二 结构化拒绝：失败统一携带 error/code/riskLevel/reason/unlockHint 信封，未注册 → unknown-tool', async () => {
  const root = makeTmpRoot('tp-b2-');
  const res = asB2Failure(await executeTool('no_such_b2_tool', {}, makeCtx(root)));
  assert.equal(res.ok, false);
  for (const key of ['error', 'code', 'riskLevel', 'reason'] as const) {
    assert.ok(key in res, `失败信封应含字段：${key}`);
  }
  assert.equal(res.code, 'unknown-tool');
  assert.ok(B2_ERROR_CODES.includes(res.code), `code 应在契约枚举内：${res.code}`);
  assert.ok(B2_RISK_LEVELS.includes(res.riskLevel), `riskLevel 应在 L0~L3 内：${res.riskLevel}`);
  assert.ok(typeof res.error === 'string' && res.error.length > 0, 'error 应非空');
  assert.ok(typeof res.reason === 'string' && res.reason.length > 0, 'reason 应非空');
});

test('第6期批次二 结构化拒绝：run_shell 未授权 → danger-disabled，unlockHint 指引 THATPERSON_ENABLE_SHELL', async () => {
  const root = makeTmpRoot('tp-b2-');
  const saved = process.env.THATPERSON_ENABLE_SHELL;
  process.env.THATPERSON_ENABLE_SHELL = 'true';
  try {
    registerBuiltins();
    const res = asB2Failure(await executeTool('run_shell', { command: 'echo hi' }, makeCtx(root)));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'danger-disabled');
    assert.equal(res.riskLevel, 'L3', 'run_shell 风险等级应为 L3');
    assert.ok(
      res.unlockHint !== undefined && res.unlockHint.includes('THATPERSON_ENABLE_SHELL'),
      `unlockHint 应指引 THATPERSON_ENABLE_SHELL：${res.unlockHint}`,
    );
  } finally {
    if (saved === undefined) delete process.env.THATPERSON_ENABLE_SHELL;
    else process.env.THATPERSON_ENABLE_SHELL = saved;
    unregisterTool('run_shell');
  }
});

test('第6期批次二 结构化拒绝：list_directory 白名单外 → path-denied，unlockHint 指引 allow-dir', async () => {
  const root = makeTmpRoot('tp-b2-');
  const outside = makeTmpRoot('tp-b2-out-');
  try {
    const res = asB2Failure(await executeTool('list_directory', { dir: outside }, makeCtx(root)));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'path-denied');
    assert.ok(
      res.unlockHint !== undefined && res.unlockHint.includes('allow-dir'),
      `unlockHint 应指引 allow-dir：${res.unlockHint}`,
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('第6期批次二 结构化拒绝：必填缺失 → param-invalid', async () => {
  const root = makeTmpRoot('tp-b2-');
  const res = asB2Failure(await executeTool('read_file', {}, makeCtx(root)));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'param-invalid');
});

test('第6期批次二 结构化拒绝：move_file 目标已存在 → conflict', async () => {
  const root = makeTmpRoot('tp-b2-');
  fs.mkdirSync(path.join(root, 'a'));
  fs.mkdirSync(path.join(root, 'b'));
  const src = path.join(root, 'a', 'x.txt');
  fs.writeFileSync(src, '数据', 'utf8');
  fs.writeFileSync(path.join(root, 'b', 'x.txt'), '已存在', 'utf8');
  const res = asB2Failure(
    await executeTool('move_file', { source: src, targetDir: path.join(root, 'b') }, makeCtx(root)),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'conflict');
  assert.ok(fs.existsSync(src), '冲突时源文件不应被移动');
});

test('第6期批次二 结构化拒绝：edit_vault_note 红线文件 → redline-denied', async () => {
  const root = makeTmpRoot('tp-b2-');
  const redline = path.join(root, '.env');
  fs.writeFileSync(redline, 'SK=1\n', 'utf8');
  const res = asB2Failure(await executeTool('edit_vault_note', { file: redline, content: 'x' }, makeCtx(root)));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'redline-denied');
});

test('第6期批次二 riskLevel 标注：read=L0、记忆写=L1、文件写=L2、run_shell=L3', () => {
  const levelOf = (name: string): B2RiskLevel => {
    const def = listTools().find((t) => t.name === name);
    assert.ok(def, `应存在工具：${name}`);
    return (def as B2ToolDef & { riskLevel: B2RiskLevel }).riskLevel;
  };
  for (const t of listTools()) {
    assert.ok(
      B2_RISK_LEVELS.includes((t as B2ToolDef & { riskLevel: B2RiskLevel }).riskLevel),
      `每个工具都应有合法 riskLevel：${t.name}`,
    );
  }
  for (const name of ['list_directory', 'read_file', 'read_vault_note', 'search_vault', 'search_memory']) {
    assert.equal(levelOf(name), 'L0', `${name} 应为 L0`);
  }
  assert.equal(levelOf('append_memory'), 'L1');
  assert.equal(levelOf('edit_present'), 'L1');
  for (const name of ['move_file', 'rename_file', 'create_directory', 'edit_vault_note']) {
    assert.equal(levelOf(name), 'L2', `${name} 应为 L2`);
  }
  const savedShell = process.env.THATPERSON_ENABLE_SHELL;
  process.env.THATPERSON_ENABLE_SHELL = 'true';
  try {
    registerBuiltins();
    assert.equal(levelOf('run_shell'), 'L3', 'run_shell 应为 L3');
  } finally {
    if (savedShell === undefined) delete process.env.THATPERSON_ENABLE_SHELL;
    else process.env.THATPERSON_ENABLE_SHELL = savedShell;
    unregisterTool('run_shell');
  }
  const savedWeb = process.env.THATPERSON_ENABLE_WEB_SEARCH;
  process.env.THATPERSON_ENABLE_WEB_SEARCH = 'true';
  try {
    registerBuiltins();
    assert.equal(levelOf('web_search'), 'L0', 'web_search（read）应为 L0');
  } finally {
    if (savedWeb === undefined) delete process.env.THATPERSON_ENABLE_WEB_SEARCH;
    else process.env.THATPERSON_ENABLE_WEB_SEARCH = savedWeb;
    unregisterTool('web_search');
  }
});

test('第6期批次二 allow-dir 闭环：授权目录并入 allowedRoots，授权后同 ctx 重试成功；未授权目录仍拒绝', async () => {
  const root = makeTmpRoot('tp-b2-');
  const granted = makeTmpRoot('tp-b2-grant-');
  const stillDenied = makeTmpRoot('tp-b2-deny-');
  fs.writeFileSync(path.join(granted, 'secret.txt'), '授权目录内容', 'utf8');
  fs.writeFileSync(path.join(stillDenied, 'other.txt'), '未授权', 'utf8');
  const ctx = makeCtx(root);
  try {
    const before = asB2Failure(await executeTool('read_file', { path: path.join(granted, 'secret.txt') }, ctx));
    assert.equal(before.ok, false, '授权前应拒绝');
    assert.equal(before.code, 'path-denied');
    assert.ok(
      before.unlockHint !== undefined && before.unlockHint.includes('allow-dir'),
      '授权前拒绝应带 allow-dir 解锁提示',
    );

    const auth = configB2.allowDir(granted);
    assert.equal(auth.ok, true, 'allowDir 应授权成功');

    const after = await executeTool('read_file', { path: path.join(granted, 'secret.txt') }, ctx);
    assert.equal(after.ok, true, '授权后同 ctx 重试应成功');
    if (after.ok) assert.ok(after.content.includes('授权目录内容'), '应读到授权目录内容');

    const denied = asB2Failure(await executeTool('read_file', { path: path.join(stillDenied, 'other.txt') }, ctx));
    assert.equal(denied.ok, false, '未授权目录仍应拒绝');
    assert.equal(denied.code, 'path-denied');
  } finally {
    fs.rmSync(granted, { recursive: true, force: true });
    fs.rmSync(stillDenied, { recursive: true, force: true });
    resetAllowedDirs();
  }
});

test('第6期批次二 allow-dir 闭环（loop）：授权目录并入 allowedRoots，mock 读取命中', async () => {
  const cwd = makeTmpRoot('tp-b2-loop-');
  const granted = makeTmpRoot('tp-b2-loop-grant-');
  const secretFile = path.join(granted, 'note.md');
  fs.writeFileSync(secretFile, '授权后可读内容', 'utf8');
  process.env.THATPERSON_MOCK_TOOL_CALLS = JSON.stringify([
    [{ id: 'call_1', name: 'read_file', arguments: JSON.stringify({ path: secretFile }) }],
    [],
  ]);
  try {
    const auth = configB2.allowDir(granted);
    assert.equal(auth.ok, true);
    const result = await withCwd(cwd, () =>
      runAgentLoop({ userPrompt: '读取外部笔记', memories: EMPTY_MEMORIES, isMock: true }),
    );
    assert.equal(result.toolLog.length, 1);
    assert.equal(result.toolLog[0].status, 'ok', '授权目录应在 loop allowedRoots 中命中');
  } finally {
    delete process.env.THATPERSON_MOCK_TOOL_CALLS;
    resetAllowedDirs();
  }
});

test('第6期批次二 分级话术：卡点诊断模板含「等级/守卫/解锁」，不再出现「我做不到」', async () => {
  const cwd = makeTmpRoot('tp-b2-loop-');
  const rounds = Array.from({ length: 3 }, () => [
    { id: 'call', name: 'no_such_tool', arguments: '{}' },
  ]);
  process.env.THATPERSON_MOCK_TOOL_CALLS = JSON.stringify(rounds);
  try {
    const result = await withCwd(cwd, () =>
      runAgentLoop({ userPrompt: '执行一下', memories: EMPTY_MEMORIES, isMock: true }),
    );
    for (const kw of ['等级', '守卫', '解锁']) {
      assert.ok(result.reply.includes(kw), `认输/诊断话术应含「${kw}」，实际：${result.reply}`);
    }
    assert.ok(!result.reply.includes('我做不到'), '卡点诊断模板不应出现「我做不到」');
  } finally {
    delete process.env.THATPERSON_MOCK_TOOL_CALLS;
  }
});

test('KS-18 结果截断：超长输出截断到 RESULT_CHAR_LIMIT 并带标记', async () => {
  const root = makeTmpRoot('tp-tools-');
  registerTool({
    name: 'test_long_output',
    description: '测试超长输出',
    params: [],
    policy: 'read',
    handler: () => ({ ok: true, content: 'x'.repeat(RESULT_CHAR_LIMIT * 2) }),
  });
  try {
    const result = await executeTool('test_long_output', {}, makeCtx(root));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.content.length <= RESULT_CHAR_LIMIT, '截断后不应超过上限');
      assert.ok(result.content.endsWith('…[已截断]'), '应带截断标记');
    }
  } finally {
    unregisterTool('test_long_output');
  }
});

test('truncateResult：短内容原样返回，超长截断', () => {
  assert.equal(truncateResult('short'), 'short');
  const long = truncateResult('a'.repeat(RESULT_CHAR_LIMIT + 100));
  assert.ok(long.length <= RESULT_CHAR_LIMIT);
  assert.ok(long.endsWith('…[已截断]'));
});

// ===== 内置工具正常路径 =====

test('KS-22 read_vault_note：按路径 / 按日期（含中文日期）读取笔记，穿越拒绝', async () => {
  const root = makeTmpRoot('tp-vault-');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes', 'diary.md'), '今天喝了燕麦拿铁，很满足。\n明天要去爬山。', 'utf8');
  fs.writeFileSync(path.join(root, 'notes', '2026-07-31.md'), '七月最后一天，项目上线。', 'utf8');
  const ctx = makeCtx(root);

  const byPath = await executeTool('read_vault_note', { path: path.join(root, 'notes', 'diary.md') }, ctx);
  assert.equal(byPath.ok, true);
  if (byPath.ok) assert.ok(byPath.content.includes('燕麦拿铁'));

  const byDate = await executeTool('read_vault_note', { date: '2026-07-31' }, ctx);
  assert.equal(byDate.ok, true);
  if (byDate.ok) assert.ok(byDate.content.includes('项目上线'));

  const cnDate = await executeTool('read_vault_note', { date: '2026年7月31日' }, ctx);
  assert.equal(cnDate.ok, true);

  const missing = await executeTool('read_vault_note', { date: '1999-01-01' }, ctx);
  assert.equal(missing.ok, false);

  const escape = await executeTool('read_vault_note', { path: path.join(root, '..', 'secret.md') }, ctx);
  assert.equal(escape.ok, false);
  if (!escape.ok) assert.equal(escape.error, 'path-not-allowed');
});

test('KS-22 search_vault：递归搜索 .md 行命中并返回 ≤10 条', async () => {
  const root = makeTmpRoot('tp-vault-');
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'b', 'note.md'), '山顶的风很舒服。\n咖啡也不错。', 'utf8');
  const ctx = makeCtx(root);

  const hits = await executeTool('search_vault', { keyword: '山顶' }, ctx);
  assert.equal(hits.ok, true);
  if (hits.ok) {
    assert.ok(hits.content.includes('note.md'), '命中应带文件名');
    assert.ok(hits.content.includes('山顶的风很舒服'), '命中应带行内容');
  }

  const none = await executeTool('search_vault', { keyword: '不存在的词xyz' }, ctx);
  assert.equal(none.ok, true);
  if (none.ok) assert.ok(none.content.includes('无命中'));
});

test('KS-22 append_memory：写入 home/history 对应归档文件，不覆盖既有内容', async () => {
  const root = makeTmpRoot('tp-mem-');
  const prefsPath = path.join(root, 'history', 'profile', 'preferences.md');
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(
    prefsPath,
    '## 2026-08-01\n\n### [归档类型：偏好]\n\n- **提炼信息**：旧内容\n',
    'utf8',
  );
  const ctx = makeCtx(root);

  const res = await executeTool(
    'append_memory',
    { type: '偏好', insight: '喜欢燕麦拿铁', dialog: '今天喝了拿铁', confidence: '高' },
    ctx,
  );
  assert.equal(res.ok, true);

  const content = fs.readFileSync(prefsPath, 'utf8');
  assert.ok(content.includes('旧内容'), '既有内容不得被覆盖');
  assert.ok(content.includes('### [归档类型：偏好]'));
  assert.ok(content.includes('喜欢燕麦拿铁'));
  assert.ok(content.includes('置信度**：高'));
});

test('KS-22 edit_present：append 追加段落；replace 精确匹配替换；冲突拒绝', async () => {
  const root = makeTmpRoot('tp-present-');
  const identityPath = path.join(root, 'present', 'identity.md');
  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  fs.writeFileSync(identityPath, '我叫小水。\n喜欢安静。\n', 'utf8');
  const ctx = makeCtx(root);

  const appended = await executeTool('edit_present', { file: 'identity.md', content: '以后叫我小水水。' }, ctx);
  assert.equal(appended.ok, true);
  let content = fs.readFileSync(identityPath, 'utf8');
  assert.ok(content.includes('以后叫我小水水。'));

  const replaced = await executeTool(
    'edit_present',
    { file: 'identity.md', content: '喜欢安静与咖啡。', mode: 'replace', oldValue: '喜欢安静。' },
    ctx,
  );
  assert.equal(replaced.ok, true);
  content = fs.readFileSync(identityPath, 'utf8');
  assert.ok(content.includes('喜欢安静与咖啡。'));
  assert.ok(!content.includes('喜欢安静。'), '旧行应被替换');

  const conflict = await executeTool(
    'edit_present',
    { file: 'identity.md', content: 'x', mode: 'replace', oldValue: '不存在的行' },
    ctx,
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error, 'conflict');

  const badFile = await executeTool('edit_present', { file: 'secret.md', content: 'x' }, ctx);
  assert.equal(badFile.ok, false);
  if (!badFile.ok) assert.equal(badFile.error, 'file-not-in-whitelist');
});

// ===== ReAct 循环（全部 mock，不发起真实 API） =====

test('KS-20 loop 三段：解析→执行→回灌→再推理，审计日志只记参数键名', async () => {
  const cwd = makeTmpRoot('tp-loop-');
  const secretFile = path.join(cwd, 'secret.txt');
  fs.writeFileSync(secretFile, '机密内容', 'utf8');
  process.env.THATPERSON_MOCK_TOOL_CALLS = JSON.stringify([
    [{ id: 'call_1', name: 'read_file', arguments: JSON.stringify({ path: secretFile }) }],
    [],
  ]);
  try {
    const result = await withCwd(cwd, () =>
      runAgentLoop({ userPrompt: '读取文件', memories: EMPTY_MEMORIES, isMock: true }),
    );
    assert.ok(result.reply.startsWith('（离线演示）'), 'mock 回复应以（离线演示）开头');
    assert.equal(result.toolLog.length, 1, '应执行一次工具调用');
    assert.equal(result.toolLog[0].tool, 'read_file');
    assert.equal(result.toolLog[0].status, 'ok');
    assert.deepEqual(result.toolLog[0].argsKeys, ['path'], '审计只记录参数键名');

    const logDir = path.join(iso.home, 'logs');
    const files = fs.readdirSync(logDir).filter((f) => f.startsWith('tool-') && f.endsWith('.jsonl'));
    assert.ok(files.length >= 1, '审计日志应落盘');
    const lines = fs
      .readFileSync(path.join(logDir, files[0]), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine) as ToolLogEntry;
    assert.ok(['ts', 'tool', 'argsKeys', 'status', 'ms'].every((k) => k in entry), '审计字段齐全');
    assert.ok(!lastLine.includes(secretFile), '审计日志绝不含参数值/路径');
  } finally {
    delete process.env.THATPERSON_MOCK_TOOL_CALLS;
  }
});

test('KS-20 loop 5 轮上限：达 MAX_TOOL_ITERATIONS 后终止并附说明', async () => {
  const cwd = makeTmpRoot('tp-loop-');
  const rounds = Array.from({ length: MAX_TOOL_ITERATIONS + 1 }, () => [
    { id: 'call', name: 'list_directory', arguments: '{}' },
  ]);
  process.env.THATPERSON_MOCK_TOOL_CALLS = JSON.stringify(rounds);
  try {
    const result = await withCwd(cwd, () =>
      runAgentLoop({ userPrompt: '连续调用', memories: EMPTY_MEMORIES, isMock: true }),
    );
    assert.equal(result.toolLog.length, MAX_TOOL_ITERATIONS, `应恰好执行 ${MAX_TOOL_ITERATIONS} 轮`);
    assert.ok(result.toolLog.every((e) => e.status === 'ok'));
    assert.ok(result.reply.includes('上限'), '达上限应附说明');
  } finally {
    delete process.env.THATPERSON_MOCK_TOOL_CALLS;
  }
});

test('KS-20 loop 连续失败 3 次 → 卡点诊断（批次二升级：不再「暂时做不到」）', async () => {
  const cwd = makeTmpRoot('tp-loop-');
  const rounds = Array.from({ length: 3 }, () => [
    { id: 'call', name: 'no_such_tool', arguments: '{}' },
  ]);
  process.env.THATPERSON_MOCK_TOOL_CALLS = JSON.stringify(rounds);
  try {
    const result = await withCwd(cwd, () =>
      runAgentLoop({ userPrompt: '执行一下', memories: EMPTY_MEMORIES, isMock: true }),
    );
    assert.ok(result.reply.includes('卡点诊断'), '认输话术应为卡点诊断模板');
    assert.ok(!result.reply.includes('暂时做不到') && !result.reply.includes('我做不到'), '批次二后不再出现认输话术');
    assert.equal(result.toolLog.length, 3);
    assert.ok(result.toolLog.every((e) => e.status === 'unknown'));
  } finally {
    delete process.env.THATPERSON_MOCK_TOOL_CALLS;
  }
});

test('KS-20 loop 失败重试→成功：失败后成功调用并正常收尾', async () => {
  const cwd = makeTmpRoot('tp-loop-');
  process.env.THATPERSON_MOCK_TOOL_CALLS = JSON.stringify([
    [{ id: 'call_1', name: 'no_such_tool', arguments: '{}' }],
    [{ id: 'call_2', name: 'list_directory', arguments: '{}' }],
    [],
  ]);
  try {
    const result = await withCwd(cwd, () =>
      runAgentLoop({ userPrompt: '重试', memories: EMPTY_MEMORIES, isMock: true }),
    );
    assert.equal(result.toolLog.length, 2);
    assert.equal(result.toolLog[0].status, 'unknown');
    assert.equal(result.toolLog[1].status, 'ok');
    assert.ok(result.reply.startsWith('（离线演示）'));
    assert.ok(!result.reply.includes('暂时做不到'));
  } finally {
    delete process.env.THATPERSON_MOCK_TOOL_CALLS;
  }
});

// ===== 第 6 期批次一 · 插件化示例工具 + 三新工具（web_search / move_file / rename_file / create_directory / edit_vault_note）=====

test('第6期批次一 注册表：move_file/rename_file/create_directory/edit_vault_note 默认注册且为 write 策略', () => {
  const tools = listTools();
  for (const name of ['move_file', 'rename_file', 'create_directory', 'edit_vault_note']) {
    const def = tools.find((t) => t.name === name);
    assert.ok(def, `应默认注册新工具：${name}`);
    if (def) assert.equal(def.policy, 'write', `${name} 应为 write 策略`);
  }
  assert.ok(!tools.some((t) => t.name === 'web_search'), 'web_search 默认不应注册');
});

test('第6期批次一 参数契约：新工具 params 与约定一致', () => {
  const paramsOf = (name: string) => {
    const def = listTools().find((t) => t.name === name);
    assert.ok(def, `应存在工具：${name}`);
    return def.params.map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required ?? false,
      enum: p.enum ?? [],
    }));
  };
  assert.deepEqual(paramsOf('move_file'), [
    { name: 'source', type: 'string', required: true, enum: [] },
    { name: 'targetDir', type: 'string', required: true, enum: [] },
  ]);
  assert.deepEqual(paramsOf('rename_file'), [
    { name: 'source', type: 'string', required: true, enum: [] },
    { name: 'newName', type: 'string', required: true, enum: [] },
  ]);
  assert.deepEqual(paramsOf('create_directory'), [{ name: 'path', type: 'string', required: true, enum: [] }]);
  assert.deepEqual(paramsOf('edit_vault_note'), [
    { name: 'file', type: 'string', required: true, enum: [] },
    { name: 'content', type: 'string', required: true, enum: [] },
    { name: 'mode', type: 'string', required: false, enum: ['append', 'replace', 'frontmatter'] },
    { name: 'oldValue', type: 'string', required: false, enum: [] },
  ]);
});

test('第6期批次一 web_search：默认不注册返回 unknown-tool，THATPERSON_ENABLE_WEB_SEARCH=true 才注册且为 read 策略', async () => {
  const root = makeTmpRoot('tp-ws-');
  const ctx = makeCtx(root);

  const unregistered = await executeTool('web_search', { keyword: 'x' }, ctx);
  assert.equal(unregistered.ok, false);
  if (!unregistered.ok) assert.equal(unregistered.error, 'unknown-tool');

  process.env.THATPERSON_ENABLE_WEB_SEARCH = 'true';
  try {
    registerBuiltins();
    assert.ok(isRegistered('web_search'), '开启环境变量后应注册 web_search');
    const def = listTools().find((t) => t.name === 'web_search');
    assert.ok(def, '注册后应能查到 web_search 定义');
    if (def) {
      assert.equal(def.policy, 'read');
      assert.deepEqual(
        def.params.map((p) => ({ name: p.name, type: p.type, required: p.required ?? false, enum: p.enum ?? [] })),
        [{ name: 'keyword', type: 'string', required: true, enum: [] }],
      );
    }
  } finally {
    delete process.env.THATPERSON_ENABLE_WEB_SEARCH;
    unregisterTool('web_search');
  }
  assert.ok(!isRegistered('web_search'), '清理后 web_search 应注销');
});

test('第6期批次一 web_search：白名单内 .md 关键词命中为 path:行号: 内容 且 ≤20 条', async () => {
  const root = makeTmpRoot('tp-ws-');
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'note.md'), '山顶的风很舒服。\n咖啡也不错。', 'utf8');
  const ctx = makeCtx(root);
  process.env.THATPERSON_ENABLE_WEB_SEARCH = 'true';
  try {
    registerBuiltins();

    const hits = await executeTool('web_search', { keyword: '山顶' }, ctx);
    assert.equal(hits.ok, true);
    if (hits.ok) {
      assert.ok(hits.content.includes('note.md:1:'), '命中格式应为 path:行号: 内容');
      assert.ok(hits.content.includes('山顶的风很舒服'), '命中应带行内容');
    }

    fs.writeFileSync(
      path.join(root, 'many.md'),
      Array.from({ length: 25 }, (_, i) => `第${i}行 山顶`).join('\n'),
      'utf8',
    );
    const many = await executeTool('web_search', { keyword: '山顶' }, ctx);
    assert.equal(many.ok, true);
    if (many.ok) {
      const hitLines = many.content.split('\n').filter((l) => l.includes('.md:'));
      assert.ok(hitLines.length <= 20, `命中应 ≤20 条，实际 ${hitLines.length}`);
    }
  } finally {
    delete process.env.THATPERSON_ENABLE_WEB_SEARCH;
    unregisterTool('web_search');
  }
});

test('第6期批次一 web_search：超长命中内容经 executor 截断', async () => {
  const root = makeTmpRoot('tp-ws-');
  fs.writeFileSync(path.join(root, 'long.md'), `关键词 ${'长'.repeat(RESULT_CHAR_LIMIT + 100)}`, 'utf8');
  const ctx = makeCtx(root);
  process.env.THATPERSON_ENABLE_WEB_SEARCH = 'true';
  try {
    registerBuiltins();
    const res = await executeTool('web_search', { keyword: '关键词' }, ctx);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(res.content.length <= RESULT_CHAR_LIMIT, '截断后不应超过上限');
      assert.ok(res.content.endsWith('…[已截断]'), '应带截断标记');
    }
  } finally {
    delete process.env.THATPERSON_ENABLE_WEB_SEARCH;
    unregisterTool('web_search');
  }
});

test('第6期批次一 move_file：跨目录单文件移动成功，返回「已移动 <src> → <dst>」', async () => {
  const root = makeTmpRoot('tp-move-');
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'b'), { recursive: true });
  const src = path.join(root, 'a', 'x.txt');
  fs.writeFileSync(src, '数据', 'utf8');
  const ctx = makeCtx(root);

  const res = await executeTool('move_file', { source: src, targetDir: path.join(root, 'b') }, ctx);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.ok(res.content.includes('已移动'), '成功消息应含「已移动」');
    assert.ok(res.content.includes('→'), '成功消息应含箭头');
    assert.ok(res.content.includes('x.txt'));
  }
  assert.equal(fs.existsSync(src), false, '源文件应被移走');
  assert.ok(fs.existsSync(path.join(root, 'b', 'x.txt')), '目标文件应存在');
});

test('第6期批次一 move_file：目录批量移动成功', async () => {
  const root = makeTmpRoot('tp-move-');
  fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dst'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'f1.txt'), '一', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'sub', 'f2.txt'), '二', 'utf8');
  const ctx = makeCtx(root);

  const res = await executeTool('move_file', { source: path.join(root, 'src'), targetDir: path.join(root, 'dst') }, ctx);
  assert.equal(res.ok, true);
  if (res.ok) assert.ok(res.content.includes('已移动'));
  assert.equal(fs.existsSync(path.join(root, 'src')), false, '源目录应被移走');
  const findIn = (dir: string, name: string): boolean => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && findIn(full, name)) return true;
      if (entry.isFile() && entry.name === name) return true;
    }
    return false;
  };
  assert.ok(findIn(path.join(root, 'dst'), 'f1.txt'), 'f1.txt 应批量移动到目标目录');
  assert.ok(findIn(path.join(root, 'dst'), 'f2.txt'), 'f2.txt 应批量移动到目标目录');
});

test('第6期批次一 move_file：目标已存在返回 conflict，源白名单外返回 path-denied', async () => {
  const root = makeTmpRoot('tp-move-');
  fs.mkdirSync(path.join(root, 'a'));
  fs.mkdirSync(path.join(root, 'b'));
  const src = path.join(root, 'a', 'x.txt');
  fs.writeFileSync(src, '数据', 'utf8');
  const target = path.join(root, 'b', 'x.txt');
  fs.writeFileSync(target, '已存在', 'utf8');
  const ctx = makeCtx(root);

  const conflict = await executeTool('move_file', { source: src, targetDir: path.join(root, 'b') }, ctx);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.ok(conflict.error.startsWith('conflict: 目标已存在：'), `应以 conflict: 目标已存在： 开头，实际 ${conflict.error}`);
    assert.ok(conflict.error.includes(target), '错误应带目标路径');
  }
  assert.ok(fs.existsSync(src), '冲突时源文件不应被移动');

  const outside = path.join(os.tmpdir(), `tp-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'secret', 'utf8');
  try {
    const denied = await executeTool('move_file', { source: outside, targetDir: path.join(root, 'b') }, ctx);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.ok(denied.error.startsWith('path-denied'), `白名单外源应 path-denied，实际 ${denied.error}`);
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('第6期批次一 rename_file：同目录改名成功，newName 含路径分隔符拒绝，目标已存在冲突', async () => {
  const root = makeTmpRoot('tp-rename-');
  const oldPath = path.join(root, 'old.txt');
  const newPath = path.join(root, 'new.txt');
  const takenPath = path.join(root, 'taken.txt');
  fs.writeFileSync(oldPath, '内容', 'utf8');
  fs.writeFileSync(takenPath, '占位', 'utf8');
  const ctx = makeCtx(root);

  const ok = await executeTool('rename_file', { source: oldPath, newName: 'new.txt' }, ctx);
  assert.equal(ok.ok, true);
  assert.equal(fs.existsSync(newPath), true, '改名后新文件应存在');
  assert.equal(fs.existsSync(oldPath), false, '改名后旧文件应消失');

  const badSep = await executeTool('rename_file', { source: newPath, newName: `sub${path.sep}x.txt` }, ctx);
  assert.equal(badSep.ok, false);
  if (!badSep.ok) assert.ok(badSep.error.length > 0, 'newName 含路径分隔符应返回错误');
  assert.equal(fs.existsSync(newPath), true, '拒绝后源文件应保留');
  assert.equal(fs.existsSync(path.join(root, 'sub', 'x.txt')), false, '拒绝后不应创建新文件');

  const conflict = await executeTool('rename_file', { source: newPath, newName: 'taken.txt' }, ctx);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.ok(conflict.error.includes('conflict'), `目标已存在应冲突，实际 ${conflict.error}`);
  assert.ok(fs.existsSync(newPath), '冲突后源文件应保留');
});

test('第6期批次一 create_directory：递归创建成功，已存在幂等 ok，白名单外拒绝', async () => {
  const root = makeTmpRoot('tp-mkdir-');
  const ctx = makeCtx(root);
  const target = path.join(root, 'a', 'b', 'c');

  const first = await executeTool('create_directory', { path: target }, ctx);
  assert.equal(first.ok, true);
  assert.ok(fs.statSync(target).isDirectory(), '目录应已创建');

  const again = await executeTool('create_directory', { path: target }, ctx);
  assert.equal(again.ok, true, '已存在应幂等返回 ok');

  const outside = path.join(os.tmpdir(), `tp-outside-mkdir-${Date.now()}`);
  try {
    const denied = await executeTool('create_directory', { path: outside }, ctx);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.ok(denied.error.length > 0, '白名单外应返回错误');
    assert.equal(fs.existsSync(outside), false, '白名单外不应创建目录');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('第6期批次一 edit_vault_note：append 追加 / replace 精确行替换 / oldValue 不匹配 conflict', async () => {
  const root = makeTmpRoot('tp-vault-edit-');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  const notePath = path.join(root, 'notes', 'note.md');
  fs.writeFileSync(notePath, '第一行\n第二行\n', 'utf8');
  const ctx = makeCtx(root);

  const appended = await executeTool('edit_vault_note', { file: notePath, content: '追加内容' }, ctx);
  assert.equal(appended.ok, true);
  let content = fs.readFileSync(notePath, 'utf8');
  assert.ok(content.includes('追加内容'), 'append 应追加内容');
  assert.ok(content.includes('第一行'), 'append 不应覆盖原内容');

  const replaced = await executeTool(
    'edit_vault_note',
    { file: notePath, content: '替换行', mode: 'replace', oldValue: '第二行' },
    ctx,
  );
  assert.equal(replaced.ok, true);
  content = fs.readFileSync(notePath, 'utf8');
  assert.ok(content.includes('替换行'), 'replace 应替换目标行');
  assert.ok(!content.includes('第二行'), '被替换行应消失');

  const conflict = await executeTool(
    'edit_vault_note',
    { file: notePath, content: 'x', mode: 'replace', oldValue: '不存在的行' },
    ctx,
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error, 'conflict');
});

test('第6期批次一 edit_vault_note：frontmatter 模式补/改键值且不破坏正文', async () => {
  const root = makeTmpRoot('tp-vault-edit-');
  const barePath = path.join(root, 'bare.md');
  fs.writeFileSync(barePath, '正文内容\n', 'utf8');
  const fmPath = path.join(root, 'fm.md');
  fs.writeFileSync(fmPath, '---\ntitle: 旧标题\ntags: []\n---\n已有正文\n', 'utf8');
  const ctx = makeCtx(root);

  const added = await executeTool('edit_vault_note', { file: barePath, content: 'title: 新标题', mode: 'frontmatter' }, ctx);
  assert.equal(added.ok, true);
  const bare = fs.readFileSync(barePath, 'utf8');
  assert.ok(bare.includes('title: 新标题'), 'frontmatter 应补充键值');
  assert.ok(bare.includes('---'), '应写入 frontmatter 分隔符');
  assert.ok(bare.includes('正文内容'), '正文不应被破坏');

  const changed = await executeTool('edit_vault_note', { file: fmPath, content: 'title: 更新标题', mode: 'frontmatter' }, ctx);
  assert.equal(changed.ok, true);
  const fm = fs.readFileSync(fmPath, 'utf8');
  assert.ok(fm.includes('title: 更新标题'), 'frontmatter 应更新键值');
  assert.ok(fm.includes('已有正文'), '正文不应被破坏');
});

test('第6期批次一 edit_vault_note：非 .md 拒绝、红线文件永远拒绝、不静默覆盖既有内容', async () => {
  const root = makeTmpRoot('tp-vault-edit-');
  const notePath = path.join(root, 'note.md');
  fs.writeFileSync(notePath, '原始内容\n', 'utf8');
  const ctx = makeCtx(root);

  const txt = await executeTool('edit_vault_note', { file: path.join(root, 'a.txt'), content: 'x' }, ctx);
  assert.equal(txt.ok, false);
  if (!txt.ok) assert.ok(txt.error.length > 0, '非 .md 文件应返回错误');

  for (const redline of [
    path.join(root, '.env'),
    path.join(root, 'API-key.md'),
    path.join(root, 'secret.key'),
    path.join(root, '.gitignore'),
  ]) {
    const res = await executeTool('edit_vault_note', { file: redline, content: 'x' }, ctx);
    assert.equal(res.ok, false, `红线文件应永远拒绝：${redline}`);
  }

  await executeTool('edit_vault_note', { file: notePath, content: '新内容' }, ctx);
  const after = fs.readFileSync(notePath, 'utf8');
  assert.ok(after.includes('原始内容'), '未显式 mode=replace+oldValue 时不得静默覆盖既有内容');
});

test('第6期批次一 路径穿越：../、白名单外、\\0 一律拒绝', async () => {
  const root = makeTmpRoot('tp-traverse-');
  fs.mkdirSync(path.join(root, 'a'));
  const src = path.join(root, 'a', 'x.txt');
  fs.writeFileSync(src, 'x', 'utf8');
  const ctx = makeCtx(root);
  const outsideFile = path.join(os.tmpdir(), `tp-outside-${Date.now()}.txt`);
  fs.writeFileSync(outsideFile, 'secret', 'utf8');
  try {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['move_file', { source: path.join(root, '..', 'escape.txt'), targetDir: path.join(root, 'a') }],
      ['move_file', { source: src, targetDir: path.join(root, '..') }],
      ['move_file', { source: outsideFile, targetDir: path.join(root, 'a') }],
      ['move_file', { source: `${src}\0evil`, targetDir: path.join(root, 'a') }],
      ['rename_file', { source: path.join(root, '..', 'escape.txt'), newName: 'x.txt' }],
      ['rename_file', { source: src, newName: `sub${path.sep}deep.txt` }],
      ['create_directory', { path: path.join(root, '..', 'evil-dir') }],
      ['create_directory', { path: outsideFile }],
      ['create_directory', { path: `${path.join(root, 'ok')}\0x` }],
      ['edit_vault_note', { file: path.join(root, '..', 'secret.md'), content: 'x' }],
    ];
    for (const [name, args] of cases) {
      const res = await executeTool(name, args, ctx);
      assert.equal(res.ok, false, `${name} 应拒绝：${JSON.stringify(args)}`);
      if (!res.ok) assert.ok(res.error.length > 0, `${name} 应返回错误码`);
    }
  } finally {
    fs.rmSync(outsideFile, { force: true });
  }
});
