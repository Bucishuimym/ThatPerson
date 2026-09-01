/**
 * 超时与韧性测试（第 7 期批次三 T11b · D-4 红侧先行；S-8/S-9，KS-7.27）
 *
 * 契约（D-3b 按此实现）：
 * - S-8 chatTimeoutMs(promptChars) 纯函数：30s 基线、随 prompt 规模单调不减且可递增、
 *   硬上限 120s、THATPERSON_CHAT_TIMEOUT_MS env 可调（显式设置=固定值，优先级最高）；
 * - S-9 进程韧性（行为级）：子进程 spawn `node dist/src/cli.js --mock --input-file` +
 *   THATPERSON_FAULT_INJECT=unhandled-rejection（兜底钩子由壳/D-3b 提供）→
 *   进程不崩（退出码 0 或正常 stdin EOF 结束）且输出含卡点诊断（超时/上下文规模/输「继续」重试）。
 *
 * 红侧现状：chatTimeoutMs 为 not-implemented 壳 → S-8 红；S-9 的兜底诊断输出未接线 → 红。
 * 全部离线零 Key（--mock 不发网络）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { chatTimeoutMs } from '../src/chat';
import { isolateHome } from './helpers';

const iso = isolateHome();
test.after(() => iso.restore());

// ===== S-8：chatTimeoutMs 纯函数 =====

test('S-8 chatTimeoutMs：30s 基线、随 prompt 规模递增、上限 120s、env 可调', () => {
  // 基线：小 prompt → 30s（对齐现状 chat() 的 AbortSignal.timeout(30_000)）
  assert.equal(chatTimeoutMs(100), 30_000, '小 prompt 应取 30s 基线');
  // 单调不减且随规模递增
  const small = chatTimeoutMs(1_000);
  const mid = chatTimeoutMs(50_000);
  const large = chatTimeoutMs(500_000);
  assert.ok(mid >= small && large >= mid, '超时应随 prompt 规模单调不减');
  assert.ok(mid > small, 'prompt 规模显著增大时超时应递增（不是常数）');
  // 上限 120s
  assert.ok(large <= 120_000, '超时上限 120s，实际：' + String(large));
  assert.equal(chatTimeoutMs(50_000_000), 120_000, '超大 prompt 应钳制在 120s');
  // env 可调：THATPERSON_CHAT_TIMEOUT_MS 显式设置 → 固定值（优先级最高）
  const saved = process.env.THATPERSON_CHAT_TIMEOUT_MS;
  process.env.THATPERSON_CHAT_TIMEOUT_MS = '45000';
  try {
    assert.equal(chatTimeoutMs(100), 45_000, 'env 设置应覆盖计算值（固定 45s）');
    assert.equal(chatTimeoutMs(500_000), 45_000, 'env 设置对小/大 prompt 一律生效');
  } finally {
    if (saved === undefined) delete process.env.THATPERSON_CHAT_TIMEOUT_MS;
    else process.env.THATPERSON_CHAT_TIMEOUT_MS = saved;
  }
});

// ===== S-9：子进程注入 unhandledRejection（行为级）=====

test('S-9 注入 unhandledRejection：子进程不崩（退出码 0）且输出卡点诊断', async () => {
  const root = fs.mkdtempSync(path.join(iso.home, 'resilience-s9-'));
  const cliPath = path.resolve(__dirname, '..', '..', 'dist', 'src', 'cli.js');
  if (!fs.existsSync(cliPath)) {
    throw new Error(`dist/src/cli.js 不存在，请先 npm run build（实际查找：${cliPath}）`);
  }
  const inputFile = path.join(root, 'input.txt');
  fs.writeFileSync(inputFile, '就聊聊今天天气，一句就好。', 'utf8');
  const chunks: string[] = [];
  let stderrTail = '';
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, '--mock', '--input-file', inputFile],
      {
        cwd: root,
        env: {
          ...process.env,
          THATPERSON_HOME: iso.home,
          THATPERSON_FAULT_INJECT: 'unhandled-rejection', // 兜底钩子（D-3b 接线 cli 入口 process.on）
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.on('data', (d: Buffer) => chunks.push(String(d)));
    child.stderr?.on('data', (d: Buffer) => {
      const t = String(d);
      stderrTail = (stderrTail + t).slice(-500);
      chunks.push(t);
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c ?? -1);
    });
  });
  const output = chunks.join('');
  // 进程不崩：--input-file 单轮后正常结束，退出码 0（或正常 EOF 结束语义）
  assert.ok(
    code === 0,
    `注入 unhandledRejection 后进程不应崩溃，实际退出码：${code}\nstderr 末段：${stderrTail}`,
  );
  // 输出含卡点诊断：超时 / 上下文规模 / 输「继续」重试（REPL 永不裸退）
  assert.ok(
    output.includes('卡点'),
    `兜底应输出卡点诊断（含「卡点」字样，提示超时/上下文规模/输「继续」重试）\n输出末段：${output.slice(-400)}`,
  );
  fs.rmSync(root, { recursive: true, force: true });
});
