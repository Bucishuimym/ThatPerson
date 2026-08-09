import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore } from '../src/memory/store';
import type { ArchiveEntry, SessionSummary } from '../src/memory/types';

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thatgirl-test-'));
}

test('ensureStructure 创建五类记忆目录且不建空文件', () => {
  const root = makeTmpRoot();
  createMemoryStore(root).ensureStructure();
  for (const dir of ['profile', 'timeline', 'experiences', 'insights', 'session_logs']) {
    assert.ok(fs.existsSync(path.join(root, 'history', dir)), `缺少目录 ${dir}`);
  }
  let fileCount = 0;
  for (const dir of fs.readdirSync(path.join(root, 'history'))) {
    fileCount += fs.readdirSync(path.join(root, 'history', dir)).length;
  }
  assert.equal(fileCount, 0, '初始化不应创建任何空文件');
});

test('appendArchive 按提示词 4.2 格式写入偏好文件', () => {
  const root = makeTmpRoot();
  const store = createMemoryStore(root);
  store.ensureStructure();
  store.appendArchive('profile', {
    type: '偏好',
    dialog: '我还是更喜欢传统的拿铁',
    insight: '偏好传统拿铁，不喜欢肉桂等香料风味',
    confidence: '高',
    tags: ['#饮食偏好', '#咖啡'],
  });
  const content = fs.readFileSync(path.join(root, 'history/profile/preferences.md'), 'utf8');
  assert.match(content, /## 2026-/);
  assert.match(content, /### \[归档类型：偏好\]/);
  assert.match(content, /<dialog>"我还是更喜欢传统的拿铁"<\/dialog>/);
  assert.match(content, /`#饮食偏好` `#咖啡`/);
  assert.match(content, /置信度\*\*：高/);
});

test('同一日期多条归档合并到同一日期标题', () => {
  const root = makeTmpRoot();
  const store = createMemoryStore(root);
  store.ensureStructure();
  const base: ArchiveEntry = { type: '偏好', dialog: 'd', insight: 'i', confidence: '高', tags: [] };
  store.appendArchive('profile', { ...base, insight: '第一条' });
  store.appendArchive('profile', { ...base, insight: '第二条' });
  const content = fs.readFileSync(path.join(root, 'history/profile/preferences.md'), 'utf8');
  const dateHeadings = content.match(/^## 2026-/gm) ?? [];
  assert.equal(dateHeadings.length, 1, '同一日期应只有一个日期标题');
  assert.match(content, /第一条/);
  assert.match(content, /第二条/);
});

test('appendSessionLog 按提示词 4.3 写入当日摘要', () => {
  const root = makeTmpRoot();
  const store = createMemoryStore(root);
  store.ensureStructure();
  const summary: SessionSummary = {
    date: '2026-08-08',
    topics: ['咖啡'],
    mood: '平静',
    newMemories: ['偏好 | 喜欢传统拿铁 | 高'],
    followUps: ['周末去书店'],
  };
  store.appendSessionLog(summary);
  const file = path.join(root, 'history/session_logs/2026-08-08.md');
  assert.ok(fs.existsSync(file), '应生成当日摘要文件');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /# 对话摘要 · 2026-08-08/);
  assert.match(content, /## 核心话题/);
  assert.match(content, /## 情绪基调/);
  assert.match(content, /## 新增记忆/);
  assert.match(content, /## 待跟进事项/);
});

test('load 按提示词 2.2 顺序读取记忆', async () => {
  const root = makeTmpRoot();
  const store = createMemoryStore(root);
  store.ensureStructure();
  store.appendArchive('profile', { type: '偏好', dialog: 'd', insight: '喜欢咖啡', confidence: '高', tags: [] });
  store.appendArchive('timeline', { type: '日期', dialog: 'd', insight: '生日是 3 月 12 日', confidence: '高', tags: [] });
  store.appendSessionLog({ date: '2026-08-07', topics: ['a'], mood: '平静', newMemories: [], followUps: [] });

  const mem = await store.load();
  assert.match(mem.profile['preferences.md'] ?? '', /喜欢咖啡/);
  assert.match(mem.importantDates ?? '', /生日是 3 月 12 日/);
  assert.ok(mem.recentSessions.length >= 1, '应加载最近会话摘要');
});

test('非法 section 抛出错误（防路径穿越）', () => {
  const root = makeTmpRoot();
  const store = createMemoryStore(root);
  store.ensureStructure();
  assert.throws(() => {
    store.appendArchive('../../etc' as never, { type: '偏好', dialog: 'd', insight: 'i', confidence: '高', tags: [] });
  });
});



