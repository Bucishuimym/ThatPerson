/**
 * e2e · 会话可恢复闭环（第 6 期批次三 · KS-42~KS-44；--mock 全自动）
 *
 * 运行：node --test dist-test/tests/e2e/*.test.js
 * 闭环：造历史 → saveSessionSnapshot（快照落盘 + index.json 登记）→
 *       「新 home」视角 listSessions 能看到（纯磁盘态，无内存缓存）→
 *       loadSession 恢复 → 恢复的 history/summary 作为 runAgentLoop 输入（含前情）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentLoop } from '../../src/agent/loop';
import type { ChatMessage } from '../../src/chat';
import { saveSessionSnapshot } from '../../src/cli';
import { listSessions, loadSession } from '../../src/session';
import { isolateHome } from '../helpers';

const iso = isolateHome();
test.after(() => iso.restore());

const EMPTY_MEMORIES = {
  profile: {},
  importantDates: null,
  patterns: null,
  recentSessions: [],
};

test('会话可恢复闭环：save → 新 home list 可见 → load 恢复 → loop 输入 history 含前情', async () => {
  // 1. 造历史（3 轮 = 6 条，首轮即「前情」）
  const history: ChatMessage[] = [
    { role: 'user', content: '前情：我喜欢传统拿铁' },
    { role: 'assistant', content: '记住了，下次帮你点传统拿铁。' },
    { role: 'user', content: '今天聊点别的' },
    { role: 'assistant', content: '好啊。' },
    { role: 'user', content: '周末去爬山吗' },
    { role: 'assistant', content: '好主意，注意防晒。' },
  ];
  const session = {
    history,
    summary: '早期摘要：用户喜欢传统拿铁',
    recentUserTexts: ['周末去爬山吗'],
  };
  const historyDir = path.join(iso.home, 'history');

  // 2. saveSessionSnapshot：快照落盘 + index.json 登记
  const file = saveSessionSnapshot(session, historyDir);
  assert.ok(fs.existsSync(file), '快照文件应落盘');
  assert.ok(fs.existsSync(path.join(historyDir, 'sessions', 'index.json')), 'index.json 应被创建');

  // 3. 「新 home」视角：把快照 + 索引带到全新目录（模拟换环境重读，纯磁盘态）
  const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-e2e-session-'));
  try {
    const freshHistoryDir = path.join(freshHome, 'history');
    fs.cpSync(path.join(historyDir, 'sessions'), path.join(freshHistoryDir, 'sessions'), { recursive: true });
    const metas = listSessions(freshHistoryDir);
    assert.ok(metas.length >= 1, '新 home 下 listSessions 应能看到快照');
    const id = metas[0].id;
    assert.match(id, /^session_\d{8}_\d{6}$/, 'id 应符合 session_<时间戳> 规范');

    // 4. loadSession 恢复：history 含前情
    const recovered = loadSession(id, freshHistoryDir);
    assert.ok(recovered.history.length >= 4, `应保留最近轮次，实际 ${recovered.history.length}`);
    assert.ok(recovered.history[0].content.includes('前情'), '恢复 history 应含前情');

    // 5. runAgentLoop 输入含前情：把 recovered.history / summary 喂给下一次对话
    const result = await runAgentLoop({
      userPrompt: '继续',
      memories: EMPTY_MEMORIES,
      isMock: true,
      history: recovered.history,
      summary: recovered.summary,
    });
    assert.ok(result.reply.includes('（离线演示）'), `--mock 应离线回复，实际：${result.reply}`);
  } finally {
    fs.rmSync(freshHome, { recursive: true, force: true });
  }
});
