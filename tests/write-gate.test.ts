/**
 * 写确认闸与 L2 语义测试（第 7 期批次一 · task 3b P0；W-1~W-9，KS-7.14~7.19 / DD-7.2 / DD-7.3）
 *
 * 闸本体在 loop.ts 执行器段（DD-7.3），全部用例经 runAgentLoop（--mock 注入 toolCalls）驱动：
 * - W-1 同轮 ≥3 写类 → 整批拦截 + 计划清单（源→目标）；
 * - W-2/W-3 确认桩 true/false 两分支（批准 allowed-confirmed / 拒绝整批不落盘）；
 * - W-4/W-5 混合批次与 1~2 次写零弹窗（阈值=写类 ≥3，读不计入）；
 * - W-6 结构性写 cwd 内未确认不执行（8·29 事故回归锚点）；
 * - W-7 非交互（--mock/管道）结构性写 → 结构化拒绝不自动放行；
 * - W-8 审计增强：count + targetDirKey（sha256 前 12 位 hex），无明文路径；
 * - W-9 run_shell L3 双门控回归（确认闸不改变 danger 语义）。
 *
 * 全部离线零网络；确认桩经 tests/mocks.ts 注入，审计经快照读取器断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { runAgentLoop, type ToolLogEntry } from '../src/agent/loop';
import { registerBuiltins } from '../src/tools/builtin';
import { unregisterTool } from '../src/tools/registry';
import type { LoadedMemories } from '../src/memory/types';
import { isolateHome, snapshotTree, assertTreeUnchanged } from './helpers';
import {
  installConfirmStub,
  createVaultFixture,
  readAuditEntries,
  readAuditRawLines,
  type VaultFixture,
} from './mocks';

const iso = isolateHome();
test.after(() => iso.restore());

registerBuiltins(); // 每测试文件独立进程，内置工具白名单无跨文件污染

const EMPTY_MEMORIES: LoadedMemories = {
  profile: {},
  importantDates: null,
  patterns: null,
  recentSessions: [],
};

function makeTmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 在指定目录下执行异步函数，结束后恢复原 cwd */
function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  return fn().finally(() => process.chdir(prev));
}

interface LoopResult {
  reply: string;
  toolLog: ToolLogEntry[];
}

/** 注入一轮 mock toolCalls 并以 cwd=dir 跑 ReAct 循环（rounds 后补一轮空调用收尾） */
async function runMockRounds(dir: string, rounds: Array<Array<{ id: string; name: string; arguments: string }>>): Promise<LoopResult> {
  process.env.THATPERSON_MOCK_TOOL_CALLS = JSON.stringify([...rounds, []]);
  try {
    return await withCwd(dir, () =>
      runAgentLoop({ userPrompt: '整理文件', memories: EMPTY_MEMORIES, isMock: true }),
    );
  } finally {
    delete process.env.THATPERSON_MOCK_TOOL_CALLS;
  }
}

function moveCall(id: string, source: string, targetDir: string) {
  return { id, name: 'move_file', arguments: JSON.stringify({ source, targetDir }) };
}

/** 目标目录隐私摘要的测试侧独立实现（sha256 前 12 位 hex，与 KS-7.18 口径互证） */
function expectedDirKey(dir: string): string {
  return createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12);
}

// ===== W-1：同轮 ≥3 次写调用触发确认闸 =====

test('W-1 同轮 ≥3 次写类调用触发确认闸：整批拦截并产出计划清单（源→目标）', async () => {
  const root = makeTmpRoot('tp-wg1-');
  const fixture: VaultFixture = createVaultFixture(root);
  const targets = ['归档一', '归档二', '归档三'].map((d) => {
    const dir = path.join(root, d);
    fs.mkdirSync(dir);
    return dir;
  });
  const before = snapshotTree(root);
  try {
    const result = await runMockRounds(root, [
      [
        moveCall('m1', fixture.diary, targets[0]),
        moveCall('m2', fixture.novel, targets[1]),
        moveCall('m3', fixture.note, targets[2]),
      ],
    ]);
    assert.equal(result.toolLog.length, 3, '三个写调用都应被审计');
    for (const entry of result.toolLog) {
      assert.equal(entry.status, 'error', `写调用应被闸拦截：${entry.tool}`);
      assert.equal(entry.code, 'confirm-required', '拦截应为 confirm-required');
    }
    const planText = result.toolLog.map((e) => e.reason ?? '').join('\n');
    assert.ok(planText.length > 0, '拒绝原因应回灌完整计划清单');
    for (const name of ['2026-08-01.md', '青瓷记-第一章.md', '读书笔记.md']) {
      assert.ok(planText.includes(name), `计划应包含源文件：${name}`);
    }
    for (const name of ['归档一', '归档二', '归档三']) {
      assert.ok(planText.includes(name), `计划应包含目标目录：${name}`);
    }
    // 未确认 → 整批不执行
    assertTreeUnchanged(before, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== W-2：确认桩返回 true =====

test('W-2 确认桩返回 true：逐条执行全部成功，审计逐条 allowed-confirmed', async () => {
  const root = makeTmpRoot('tp-wg2-');
  const fixture = createVaultFixture(root);
  const targets = ['a1', 'a2', 'a3'].map((d) => {
    const dir = path.join(root, d);
    fs.mkdirSync(dir);
    return dir;
  });
  const stub = installConfirmStub(true);
  try {
    const result = await runMockRounds(root, [
      [
        moveCall('m1', fixture.diary, targets[0]),
        moveCall('m2', fixture.novel, targets[1]),
        moveCall('m3', fixture.note, targets[2]),
      ],
    ]);
    assert.ok(stub.calls.length >= 1, '确认桩应被闸调用（骨架阶段未接线 → 红）');
    assert.ok(result.toolLog.every((e) => e.status === 'ok'), '批准后应逐条执行成功');
    for (const [i, name] of ['2026-08-01.md', '青瓷记-第一章.md', '读书笔记.md'].entries()) {
      assert.ok(fs.existsSync(path.join(targets[i], name)), `批准后目标文件应存在：${name}`);
    }
    const moves = readAuditEntries(iso.home).filter((e) => e.tool === 'move_file');
    assert.ok(moves.length >= 3, '审计应含本次 move 记录');
    assert.ok(
      moves.slice(-3).every((e) => e.decision === 'allowed-confirmed'),
      `批准执行的审计应为 allowed-confirmed，实际：${moves.slice(-3).map((e) => e.decision).join(',')}`,
    );
  } finally {
    stub.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== W-3：确认桩返回 false =====

test('W-3 确认桩返回 false：整批不落盘（vault 快照一致）、审计无 move 成功记录、计划回灌模型', async () => {
  const root = makeTmpRoot('tp-wg3-');
  const fixture = createVaultFixture(root);
  const targets = ['b1', 'b2', 'b3'].map((d) => {
    const dir = path.join(root, d);
    fs.mkdirSync(dir);
    return dir;
  });
  const stub = installConfirmStub(false);
  const before = snapshotTree(root);
  try {
    const result = await runMockRounds(root, [
      [
        moveCall('m1', fixture.diary, targets[0]),
        moveCall('m2', fixture.novel, targets[1]),
        moveCall('m3', fixture.note, targets[2]),
      ],
    ]);
    assert.ok(stub.calls.length >= 1, '确认桩应被闸调用');
    assert.ok(result.toolLog.every((e) => e.status === 'error' && e.code === 'confirm-required'), '拒绝应整批回灌 confirm-required');
    const planText = result.toolLog.map((e) => e.reason ?? '').join('\n');
    assert.ok(planText.includes('2026-08-01.md'), '拒绝原因应携带计划清单（回灌给模型改为提案）');
    assertTreeUnchanged(before, root);
    const allowedMoves = readAuditEntries(iso.home).filter(
      (e) => e.tool === 'move_file' && e.decision === 'allowed',
    );
    assert.equal(allowedMoves.length, 0, '审计不得出现任何 move 成功记录');
  } finally {
    stub.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== W-4：混合批次不触发闸 =====

test('W-4 混合批次：写类 2 次 + 读类 N 次 → 不触发闸（阈值=写类 ≥3，读不计入）', async () => {
  const root = makeTmpRoot('tp-wg4-');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  const notePath = path.join(root, 'notes', 'note.md');
  fs.writeFileSync(notePath, '第一行\n第二行\n', 'utf8');
  const stub = installConfirmStub(true);
  try {
    const result = await runMockRounds(root, [
      [
        { id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: notePath }) },
        { id: 'r2', name: 'read_file', arguments: JSON.stringify({ path: notePath }) },
        { id: 'w1', name: 'edit_vault_note', arguments: JSON.stringify({ file: notePath, content: '追加甲' }) },
        { id: 'w2', name: 'edit_vault_note', arguments: JSON.stringify({ file: notePath, content: '追加乙' }) },
      ],
    ]);
    assert.equal(result.toolLog.length, 4);
    assert.ok(result.toolLog.every((e) => e.status === 'ok'), '写类 2 次 + 读类不计入 → 全部直接执行');
    assert.equal(stub.calls.length, 0, '混合批次不得触发确认桩（零弹窗）');
  } finally {
    stub.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== W-5：1~2 次写零弹窗 =====

test('W-5 不误伤单文件编辑：1~2 次写零确认弹窗、直接执行（核心使用流回归）', async () => {
  const root = makeTmpRoot('tp-wg5-');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  const notePath = path.join(root, 'notes', 'diary.md');
  fs.writeFileSync(notePath, '原始内容\n', 'utf8');
  const stub = installConfirmStub(true);
  try {
    const result = await runMockRounds(root, [
      [{ id: 'w1', name: 'edit_vault_note', arguments: JSON.stringify({ file: notePath, content: '第一次追加' }) }],
      [{ id: 'w2', name: 'edit_vault_note', arguments: JSON.stringify({ file: notePath, content: '第二次追加' }) }],
    ]);
    assert.ok(result.toolLog.every((e) => e.status === 'ok'), '逐轮单文件编辑应直接执行');
    assert.equal(result.toolLog.length, 2);
    assert.equal(stub.calls.length, 0, '1~2 次写不得弹确认');
    const content = fs.readFileSync(notePath, 'utf8');
    assert.ok(content.includes('第一次追加') && content.includes('第二次追加'), '两次编辑都应落盘');
  } finally {
    stub.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== W-6：结构性写 cwd 内未确认不执行（8·29 回归锚点）=====

test('W-6 结构性写 cwd 内未确认不执行：move_file 目标在 cwd → 未确认不执行（8·29 事故回归锚点）', async () => {
  const root = makeTmpRoot('tp-wg6-');
  const src = path.join(root, 'a.txt');
  fs.writeFileSync(src, '可移动内容', 'utf8');
  const targetDir = path.join(root, 'sub');
  fs.mkdirSync(targetDir);
  try {
    // isMock（非交互）+ 无确认桩 → 视为未确认
    const result = await runMockRounds(root, [[moveCall('m1', src, targetDir)]]);
    assert.equal(result.toolLog.length, 1);
    assert.equal(result.toolLog[0].status, 'error', '结构性写未确认不得执行（修复前直接 allowed）');
    assert.equal(result.toolLog[0].code, 'confirm-required');
    assert.ok(fs.existsSync(src), '未确认时源文件不得移动');
    assert.ok(!fs.existsSync(path.join(targetDir, 'a.txt')), '未确认时目标不得出现文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== W-7：非交互下结构性写结构化拒绝 =====

test('W-7 非交互下结构性写：结构化拒绝 confirm-required，不落盘、不自动放行（对齐 KS-41 口径）', async () => {
  const root = makeTmpRoot('tp-wg7-');
  const src = path.join(root, 'old.txt');
  fs.writeFileSync(src, '内容', 'utf8');
  try {
    // isMock 即非交互（--mock / 管道同口径）；rename 目标目录 = cwd（home 外）→ 结构性写单次确认
    const result = await runMockRounds(root, [
      [{ id: 'r1', name: 'rename_file', arguments: JSON.stringify({ source: src, newName: 'new.txt' }) }],
    ]);
    const entry = result.toolLog[0];
    assert.equal(entry.status, 'error');
    assert.equal(entry.code, 'confirm-required', '非交互结构性写应结构化拒绝');
    assert.equal(entry.riskLevel, 'L2', '结构性写风险等级应为 L2');
    assert.ok((entry.reason ?? '').includes('确认'), '拒绝原因应含确认指引');
    assert.ok(fs.existsSync(src), '拒绝后源文件应保留（不自动放行）');
    assert.ok(!fs.existsSync(path.join(root, 'new.txt')), '拒绝后不得产生新文件');
    const renames = readAuditEntries(iso.home).filter((e) => e.tool === 'rename_file');
    assert.ok(renames.length >= 1 && renames.slice(-1)[0].decision === 'denied', '审计应记 denied');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== W-8：审计增强字段 =====

test('W-8 审计增强：move 审计行含 count（爆发条数）与 targetDirKey（sha256 前 12 位 hex），无明文路径', async () => {
  const root = makeTmpRoot('tp-wg8-');
  const fixture = createVaultFixture(root);
  const targets = ['c1', 'c2', 'c3'].map((d) => {
    const dir = path.join(root, d);
    fs.mkdirSync(dir);
    return dir;
  });
  const sources = [fixture.diary, fixture.novel, fixture.note];
  const stub = installConfirmStub(true);
  // 以「本用例新增的审计行」为断言范围（同进程内前序用例也会写审计）
  const linesBefore = readAuditRawLines(iso.home).length;
  try {
    const result = await runMockRounds(root, [
      [moveCall('m1', sources[0], targets[0]), moveCall('m2', sources[1], targets[1]), moveCall('m3', sources[2], targets[2])],
    ]);
    assert.ok(result.toolLog.every((e) => e.status === 'ok'), '批准后应全部执行（前置条件）');
    const newLines = readAuditRawLines(iso.home).slice(linesBefore).filter((l) => l.includes('"tool":"move_file"'));
    assert.equal(newLines.length, 3, `应新增 3 条 move 审计行，实际 ${newLines.length}`);
    const entries = newLines.map((l) => JSON.parse(l) as { decision: string; count?: number; targetDirKey?: string });
    for (const [i, entry] of entries.entries()) {
      assert.equal(entry.decision, 'allowed-confirmed', '批准执行的审计决策应为 allowed-confirmed');
      assert.equal(entry.count, 3, '审计应记本轮写类爆发条数 count=3');
      assert.equal(entry.targetDirKey, expectedDirKey(targets[i]), 'targetDirKey 应为目标目录 sha256 前 12 位 hex');
      assert.ok(/^[0-9a-f]{12}$/.test(entry.targetDirKey ?? ''), 'targetDirKey 应为 12 位小写 hex');
      for (const secret of [...sources, ...targets, root]) {
        assert.ok(!newLines[i].includes(secret), `审计行不得含明文路径：${secret}`);
      }
    }
  } finally {
    stub.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== W-9：run_shell L3 双门控回归 =====

test('W-9 run_shell 不受影响：L3 双门控路径回归（确认闸不改变 danger 语义）', async () => {
  const root = makeTmpRoot('tp-wg9-');
  const stub = installConfirmStub(true);
  const savedShell = process.env.THATPERSON_ENABLE_SHELL;
  process.env.THATPERSON_ENABLE_SHELL = 'true';
  try {
    registerBuiltins();
    // danger 工具不属于写类：同轮 3 次 run_shell 不触发写确认闸，仍走 danger 双门控
    const result = await runMockRounds(root, [
      [
        { id: 's1', name: 'run_shell', arguments: JSON.stringify({ command: 'echo hi' }) },
        { id: 's2', name: 'run_shell', arguments: JSON.stringify({ command: 'echo hi' }) },
        { id: 's3', name: 'run_shell', arguments: JSON.stringify({ command: 'echo hi' }) },
      ],
    ]);
    assert.equal(result.toolLog.length, 3);
    assert.ok(result.toolLog.every((e) => e.status === 'danger-blocked'), 'run_shell 未授权应 danger-blocked');
    assert.ok(result.toolLog.every((e) => e.code === 'danger-disabled'), 'L3 双门控语义不变');
    assert.equal(stub.calls.length, 0, '确认桩不得被 danger 工具触发');
    const shellAudit = readAuditEntries(iso.home).filter((e) => e.tool === 'run_shell');
    assert.ok(shellAudit.length >= 3 && shellAudit.slice(-3).every((e) => e.decision === 'denied'), '审计应记 denied');
  } finally {
    stub.restore();
    if (savedShell === undefined) delete process.env.THATPERSON_ENABLE_SHELL;
    else process.env.THATPERSON_ENABLE_SHELL = savedShell;
    unregisterTool('run_shell');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
