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

test('KS-20 loop 连续失败 3 次 → 认输回复', async () => {
  const cwd = makeTmpRoot('tp-loop-');
  const rounds = Array.from({ length: 3 }, () => [
    { id: 'call', name: 'no_such_tool', arguments: '{}' },
  ]);
  process.env.THATPERSON_MOCK_TOOL_CALLS = JSON.stringify(rounds);
  try {
    const result = await withCwd(cwd, () =>
      runAgentLoop({ userPrompt: '执行一下', memories: EMPTY_MEMORIES, isMock: true }),
    );
    assert.ok(result.reply.includes('暂时做不到'), '认输话术应包含「暂时做不到」');
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
