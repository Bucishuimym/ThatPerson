/**
 * 会话事件协议测试（第 7 期批次一 · task 2；E-1~E-4，KS-7.1~7.6）
 *
 * - E-1：11 类事件经事件总线发射 → sink 收集 → NDJSON 往返无损（seq/ts 装配、seq 单调递增）；
 * - E-2：事件流与 CLI 默认输出语义等值——同输入下 tool_call/tool_result 序列与审计 toolLog 一致；
 * - E-3：--events 文件 sink 可被外部解析，tool_call/tool_result 带 riskLevel/ms 元数据
 *        （CLI 接线未完成前此用例先红）；
 * - E-4：静态扫描——核心层（events/tools/agent/chat）源码无 src/web、无 inquirer/boxen/chalk/figlet/ora 泄入。
 *
 * 全部离线：E-3 子进程走 --mock，不触达网络与 Key。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EVENT_TYPES,
  clearEventSinks,
  emitEvent,
  subscribeEventSink,
  type AgentEvent,
} from '../src/events';
import { runAgentLoop, type ToolLogEntry } from '../src/agent/loop';
import type { LoadedMemories } from '../src/memory/types';
import { isolateHome } from './helpers';

const iso = isolateHome();
test.after(() => iso.restore());

const EMPTY_MEMORIES: LoadedMemories = {
  profile: {},
  importantDates: null,
  patterns: null,
  recentSessions: [],
};

function makeTmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  return fn().finally(() => process.chdir(prev));
}

/** ISO 8601 UTC 形态（协议 schema：ts 为 ISO 字符串，Z 结尾） */
function isIsoUtc(ts: string): boolean {
  return typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(ts);
}

// ===== E-1：序列化/反序列化（NDJSON 往返无损）=====

test('E-1 11 类事件经总线发射 → sink 收集 → NDJSON 往返无损，seq 单调递增', () => {
  const received: AgentEvent[] = [];
  const sink = (e: AgentEvent): void => {
    received.push(e);
  };
  subscribeEventSink(sink);
  try {
    assert.equal(EVENT_TYPES.length, 11, '批次一事件类型应为 11 类');
    // 逐类发射（覆盖全部 11 类，payload 对齐协议表）
    emitEvent({ type: 'agent_start', rounds: 1 });
    emitEvent({ type: 'agent_message', role: 'assistant', content: '（离线演示）已完成。', streaming: false });
    emitEvent({ type: 'tool_call', name: 'move_file', argsKeys: ['source', 'targetDir'], policy: 'write', riskLevel: 'L2' });
    emitEvent({ type: 'tool_result', name: 'move_file', ok: true, ms: 38, riskLevel: 'L2' });
    emitEvent({ type: 'memory_read', phase: 'load', sections: ['profile/identity.md', 'timeline/important_dates.md'] });
    emitEvent({ type: 'memory_write', tool: 'append_memory', section: 'profile', file: 'preferences.md' });
    emitEvent({ type: 'status', phase: 'end', rounds: 1, tokenUsage: { prompt: 120, completion: 30, total: 150 } });
    emitEvent({ type: 'error', tool: 'read_file', code: 'not-found', message: '源文件或目标不存在' });
    emitEvent({ type: 'session_meta', action: 'save', id: 'session_x', title: '会话标题', vaultId: 'default' });
    emitEvent({ type: 'skill_start', name: 'prompt-op' });
    emitEvent({ type: 'skill_step', name: 'prompt-op', step: 'context-inject' });
  } finally {
    clearEventSinks();
  }
  assert.equal(received.length, 11, 'sink 应收齐 11 个事件');

  // NDJSON 往返：一行一事件，JSON.parse 后与原始事件逐字段一致（无损）
  const ndjson = received.map((e) => JSON.stringify(e)).join('\n');
  const parsed = ndjson.split('\n').map((l) => JSON.parse(l) as AgentEvent);
  assert.deepEqual(parsed, received, 'NDJSON 往返必须无损');

  // BaseEvent 装配：seq 进程内单调递增、ts 为 ISO 8601 UTC
  for (const [i, event] of parsed.entries()) {
    assert.ok(isIsoUtc(event.ts), `ts 应为 ISO 8601 UTC：${event.ts}`);
    if (i > 0) assert.ok(event.seq > parsed[i - 1].seq, 'seq 应单调递增');
  }
  // 无 sink 时 no-op（不抛错）
  assert.doesNotThrow(() => emitEvent({ type: 'status', phase: 'start' }));
});

// Q-1 备忘③收口：memory_write.action 显式声明为可选字段（sediment propose/accept/reject），NDJSON 序列化不丢；无 action 的写类事件不受影响
test('memory_write.action 可选字段序列化保留（沉淀动作协议向前兼容）', () => {
  const received: AgentEvent[] = [];
  subscribeEventSink((e) => received.push(e));
  try {
    emitEvent({ type: 'memory_write', tool: 'sediment', section: 'patterns', file: 'patterns.md', action: 'propose' });
    emitEvent({ type: 'memory_write', tool: 'append_memory', section: 'profile', file: 'preferences.md' });
  } finally {
    clearEventSinks();
  }
  const ndjson = received.map((e) => JSON.stringify(e)).join('\n');
  const parsed = ndjson.split('\n').map((l) => JSON.parse(l) as { action?: string });
  assert.equal(parsed[0].action, 'propose', '沉淀事件的 action 应无损序列化');
  assert.equal(parsed[1].action, undefined, '普通写类事件不带 action 键');
});

// ===== E-2：事件流与 CLI 默认输出语义等值 =====

test('E-2 事件流与默认输出语义等值：同输入下 tool_call/tool_result 序列与审计 toolLog 一致', async () => {
  const root = makeTmpRoot('tp-ev2-');
  const fileA = path.join(root, 'a.txt');
  fs.writeFileSync(fileA, '内容甲', 'utf8');
  const received: AgentEvent[] = [];
  subscribeEventSink((e) => received.push(e));
  let toolLog: ToolLogEntry[] = [];
  try {
    process.env.THATPERSON_MOCK_TOOL_CALLS = JSON.stringify([
      [
        { id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: fileA }) },
        { id: 'c2', name: 'list_directory', arguments: '{}' },
      ],
      [],
    ]);
    const result = await withCwd(root, () =>
      runAgentLoop({ userPrompt: '读取文件并列目录', memories: EMPTY_MEMORIES, isMock: true }),
    );
    toolLog = result.toolLog;
  } finally {
    delete process.env.THATPERSON_MOCK_TOOL_CALLS;
    clearEventSinks();
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 等值口径：事件流中的 tool_call/tool_result 序列 = 审计 toolLog（同输入同序列）
  const callEvents = received.filter((e): e is Extract<AgentEvent, { type: 'tool_call' }> => e.type === 'tool_call');
  const resultEvents = received.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
  assert.deepEqual(
    callEvents.map((e) => e.name),
    toolLog.map((e) => e.tool),
    'tool_call 事件序列应与审计 toolLog 工具序列一致',
  );
  assert.deepEqual(
    resultEvents.map((e) => e.name),
    toolLog.map((e) => e.tool),
    'tool_result 事件序列应与审计 toolLog 工具序列一致',
  );
  for (const [i, event] of resultEvents.entries()) {
    assert.equal(event.ok, toolLog[i].status === 'ok', 'tool_result.ok 应与审计 status 对齐');
  }
});

// ===== E-3：--events 文件 sink 可解析（CLI 接线前先红）=====

/** spawn dist CLI（--mock + --input-file + --events），等待退出并回收输出 */
async function runCli(opts: { cwd: string; eventsFile: string; inputFile: string; mockCalls?: string }): Promise<{ code: number | null }> {
  const cliPath = path.resolve(__dirname, '..', '..', 'dist', 'src', 'cli.js');
  if (!fs.existsSync(cliPath)) {
    throw new Error(`dist/src/cli.js 不存在，请先 npm run build（实际查找：${cliPath}）`);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    THATPERSON_HOME: iso.home,
  };
  if (opts.mockCalls !== undefined) env.THATPERSON_MOCK_TOOL_CALLS = opts.mockCalls;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--mock', '--events', opts.eventsFile, '--input-file', opts.inputFile], {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      void stderr;
      resolve({ code });
    });
  });
}

test('E-3 --events 文件 sink：外部可解析完整序列，tool_call/tool_result 带 riskLevel/ms 元数据（CLI 接线前先红）', async () => {
  const root = makeTmpRoot('tp-ev3-');
  const target = path.join(root, 'secret.txt');
  fs.writeFileSync(target, '机密内容', 'utf8');
  const eventsFile = path.join(root, 'events.ndjson');
  const inputFile = path.join(root, 'input.txt');
  fs.writeFileSync(inputFile, '帮我读取文件', 'utf8');
  try {
    await runCli({
      cwd: root,
      eventsFile,
      inputFile,
      mockCalls: JSON.stringify([[{ id: 'call_1', name: 'read_file', arguments: JSON.stringify({ path: target }) }], []]),
    });
    assert.ok(fs.existsSync(eventsFile), '--events 指定的 NDJSON 文件应生成（CLI 接线未完成 → 红）');
    const events = fs
      .readFileSync(eventsFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AgentEvent);
    assert.ok(events.length > 0, '事件序列不应为空');
    for (const [i, event] of events.entries()) {
      assert.ok(isIsoUtc(event.ts), `事件 ts 应为 ISO：${event.ts}`);
      if (i > 0) assert.ok(event.seq > events[i - 1].seq, 'seq 应单调递增');
    }
    const call = events.find((e): e is Extract<AgentEvent, { type: 'tool_call' }> => e.type === 'tool_call');
    assert.ok(call, '应含 tool_call 事件');
    assert.equal(call.name, 'read_file');
    assert.deepEqual(call.argsKeys, ['path'], 'tool_call 只记参数键名');
    assert.equal(call.riskLevel, 'L0');
    const result2 = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    assert.ok(result2, '应含 tool_result 事件');
    assert.equal(result2.ok, true);
    assert.equal(typeof result2.ms, 'number', 'tool_result 应带耗时 ms 元数据');
    assert.equal(result2.riskLevel, 'L0');
    for (const type of ['agent_start', 'agent_message', 'status']) {
      assert.ok(events.some((e) => e.type === type), `事件序列应含 ${type}`);
    }
    // 隐私口径：事件流不含明文路径
    assert.ok(!fs.readFileSync(eventsFile, 'utf8').includes(target), '事件流不得泄露明文路径');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== E-4：核心层静态扫描（无 src/web、无渲染库 import 泄入）=====

test('E-4 静态扫描：核心层（events/tools/agent/chat）无 src/web、无 inquirer/boxen/chalk/figlet/ora import', () => {
  const srcRoot = path.resolve(__dirname, '..', '..', 'src');
  const targets: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.name.endsWith('.ts')) targets.push(full);
    }
  };
  // 核心层：events.ts + chat.ts + agent/ + tools/（utils/ui 属渲染层，不在扫描范围）
  targets.push(path.join(srcRoot, 'events.ts'), path.join(srcRoot, 'chat.ts'));
  collect(path.join(srcRoot, 'agent'));
  collect(path.join(srcRoot, 'tools'));

  const importRe =
    /(from\s+|require\(\s*|import\(\s*)['"](inquirer|boxen|chalk|figlet|ora|log-symbols)(?:\/[^'"]*)?['"]/;
  const offenders: string[] = [];
  for (const file of targets) {
    assert.ok(fs.existsSync(file), `待扫描核心层文件应存在：${file}`);
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('src/web')) offenders.push(`${path.relative(srcRoot, file)}: 引用 src/web`);
    if (importRe.test(text)) offenders.push(`${path.relative(srcRoot, file)}: 引入渲染库`);
  }
  assert.deepEqual(offenders, [], `核心层不得泄入 web/渲染依赖：\n${offenders.join('\n')}`);
});
