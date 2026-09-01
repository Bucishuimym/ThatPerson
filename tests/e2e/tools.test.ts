/**
 * e2e · 插件化工具与卡点诊断闭环（第 6 期批次三 · KS-36/KS-47；--mock 全自动）
 *
 * 运行：node --test dist-test/tests/e2e/*.test.js
 * 闭环：move_file 经 runAgentLoop --mock 三段真实执行（解析 → 执行 → 回灌）；
 *       连续失败 3 次 → 回复含「卡点诊断」（等级/守卫/解锁），且不含「我做不到」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentLoop } from '../../src/agent/loop';
import { registerBuiltins } from '../../src/tools/builtin';
import { isolateHome } from '../helpers';
import { installConfirmStub } from '../mocks';

const iso = isolateHome();
test.after(() => iso.restore());

registerBuiltins(); // 每测试文件独立进程，内置工具白名单无跨文件污染

const EMPTY_MEMORIES = {
  profile: {},
  importantDates: null,
  patterns: null,
  recentSessions: [],
};

function makeRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 在指定目录下执行异步函数，结束后恢复原 cwd */
async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

test('插件化跑通：move_file 经 runAgentLoop --mock 真实执行', async () => {
  const root = makeRoot('tp-e2e-move-');
  const src = path.join(root, 'a.txt');
  const targetDir = path.join(root, 'sub');
  fs.mkdirSync(targetDir);
  fs.writeFileSync(src, '可移动内容', 'utf8');
  process.env.THATPERSON_MOCK_TOOL_CALLS = JSON.stringify([
    [{ id: 'call_move', name: 'move_file', arguments: JSON.stringify({ source: src, targetDir }) }],
    [],
  ]);
  // DD-7.2：结构性写确认语义下注入自动确认桩（move 目标在 cwd=home 外 → 单次确认），四闭环不变
  const confirm = installConfirmStub(true);
  try {
    const result = await withCwd(root, () =>
      runAgentLoop({ userPrompt: '把 a.txt 移到 sub', memories: EMPTY_MEMORIES, isMock: true }),
    );
    assert.equal(result.toolLog.length, 1, '应恰有一次工具调用');
    assert.equal(result.toolLog[0].tool, 'move_file');
    assert.equal(result.toolLog[0].status, 'ok', 'move_file 应真实执行成功');
    assert.ok(fs.existsSync(path.join(targetDir, 'a.txt')), '目标文件应存在');
    assert.ok(!fs.existsSync(src), '源文件应已移走');
    assert.ok(result.reply.includes('（离线演示）'), `回复应为离线摘要，实际：${result.reply}`);
  } finally {
    confirm.restore(); // 测试后清理确认桩
    delete process.env.THATPERSON_MOCK_TOOL_CALLS;
  }
});

test('拒绝不再认输：连续失败 3 次 → 回复含「卡点诊断」且不含「我做不到」', async () => {
  const root = makeRoot('tp-e2e-giveup-');
  const rounds = Array.from({ length: 3 }, () => [{ id: 'call', name: 'no_such_tool', arguments: '{}' }]);
  process.env.THATPERSON_MOCK_TOOL_CALLS = JSON.stringify(rounds);
  try {
    const result = await withCwd(root, () =>
      runAgentLoop({ userPrompt: '执行一下', memories: EMPTY_MEMORIES, isMock: true }),
    );
    assert.ok(result.reply.includes('卡点诊断'), `应输出卡点诊断，实际：${result.reply}`);
    for (const kw of ['等级', '守卫', '解锁']) {
      assert.ok(result.reply.includes(kw), `卡点诊断应含「${kw}」，实际：${result.reply}`);
    }
    assert.ok(!result.reply.includes('我做不到'), '卡点诊断不应出现「我做不到」');
  } finally {
    delete process.env.THATPERSON_MOCK_TOOL_CALLS;
  }
});
