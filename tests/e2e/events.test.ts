/**
 * e2e · 事件协议闭环（第 7 期批次一 · e2e-1；KS-7.4 / 会话事件协议 v1.0）
 *
 * 运行：npm.cmd run build 后 node --test dist-test/tests/e2e/*.test.js
 * 闭环：子进程 spawn `node dist/src/cli.js --mock --events <tmpfile> --input-file <输入>`
 *       （THATPERSON_MOCK_TOOL_CALLS 注入一次 read_file 调用 + THATPERSON_HOME 隔离），
 *       断言 NDJSON 文件可逐行解析出 agent_start/tool_call/tool_result/agent_message/status
 *       完整序列且 seq 单调递增（从 1 起）。
 *
 * 全程离线：--mock 不调用 API、不读 Key；CLI --events 接线由 task 2 实现方完成，接线前此用例红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolateHome } from '../helpers';

const iso = isolateHome();
test.after(() => iso.restore());

/** ISO 8601 UTC 形态 */
function isIsoUtc(ts: string): boolean {
  return typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(ts);
}

test('e2e-1 事件协议：--events NDJSON 可逐行解析出完整事件序列且 seq 单调递增', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-e2e-events-'));
  const target = path.join(root, 'note.txt');
  fs.writeFileSync(target, '事件闭环测试内容', 'utf8');
  const eventsFile = path.join(root, 'events.ndjson');
  const inputFile = path.join(root, 'input.txt');
  fs.writeFileSync(inputFile, '帮我读取一下文件', 'utf8');

  const cliPath = path.resolve(__dirname, '..', '..', '..', 'dist', 'src', 'cli.js');
  if (!fs.existsSync(cliPath)) {
    assert.fail(`dist/src/cli.js 不存在，请先 npm.cmd run build（实际查找：${cliPath}）`);
  }

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cliPath, '--mock', '--events', eventsFile, '--input-file', inputFile],
        {
          cwd: root,
          env: {
            ...process.env,
            THATPERSON_HOME: iso.home,
            THATPERSON_MOCK_TOOL_CALLS: JSON.stringify([
              [{ id: 'call_1', name: 'read_file', arguments: JSON.stringify({ path: target }) }],
              [],
            ]),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    assert.ok(fs.existsSync(eventsFile), '--events 指定的 NDJSON 文件应生成（CLI 事件接线未完成 → 红）');
    const raw = fs.readFileSync(eventsFile, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    assert.ok(lines.length > 0, '事件文件不应为空');
    const events = lines.map((l, i) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(l) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`第 ${i + 1} 行不是合法 JSON：${l.slice(0, 80)}`);
      }
      return parsed;
    });

    // BaseEvent 契约：seq 从 1 起单调递增、ts 为 ISO 8601 UTC、type 必填
    assert.equal(events[0].seq, 1, '首个事件 seq 应从 1 起');
    for (const [i, event] of events.entries()) {
      assert.equal(typeof event.type, 'string', `事件应带 type：${JSON.stringify(event)}`);
      assert.ok(isIsoUtc(event.ts as string), `ts 应为 ISO 8601 UTC：${JSON.stringify(event)}`);
      if (i > 0) {
        assert.ok(
          (event.seq as number) > (events[i - 1].seq as number),
          `seq 应单调递增：${events[i - 1].seq} → ${event.seq}`,
        );
      }
    }

    // 完整序列：agent_start / tool_call / tool_result / agent_message / status
    const types = events.map((e) => e.type as string);
    for (const required of ['agent_start', 'tool_call', 'tool_result', 'agent_message', 'status']) {
      assert.ok(types.includes(required), `事件序列应含 ${required}，实际：${types.join(',')}`);
    }
    const toolCall = events.find((e) => e.type === 'tool_call') as Record<string, unknown> | undefined;
    assert.ok(toolCall, '应含 tool_call 事件');
    assert.equal(toolCall!.name, 'read_file', '注入的 read_file 调用应出现在 tool_call');
    assert.deepEqual(toolCall!.argsKeys, ['path'], 'tool_call 只记参数键名（隐私口径）');
    assert.equal(typeof toolCall!.riskLevel, 'string', 'tool_call 应带 riskLevel');
    const toolResult = events.find((e) => e.type === 'tool_result') as Record<string, unknown> | undefined;
    assert.ok(toolResult, '应含 tool_result 事件');
    assert.equal(toolResult!.ok, true, 'read_file 应执行成功');
    assert.equal(typeof toolResult!.ms, 'number', 'tool_result 应带耗时 ms');
    // 隐私口径：事件流不泄露明文路径
    assert.ok(!raw.includes(target), '事件流不得泄露明文路径');
    void code;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
