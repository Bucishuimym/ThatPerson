/**
 * 会话记录单元测试（第 6 期 · KS-42~KS-44；批次三 D-3 预研）
 * 覆盖：parseSnapshot 新/旧格式、foldToRecovered 折叠与截断、
 * listSessions 索引缺失重建一致、loadSession 恢复前情、titleSnapshot 同步。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../src/chat';
import {
  foldToRecovered,
  listSessions,
  loadSession,
  parseSnapshot,
  rebuildIndex,
  titleSnapshot,
  upsertSessionMeta,
} from '../src/session';
import { isolateHome } from './helpers';

const iso = isolateHome();
test.after(() => iso.restore());

/** 每个用例使用独立子目录，避免同 home 下文件互相残留 */
function caseDir(name: string): string {
  return path.join(iso.home, name);
}

function rounds(n: number, prefix = 'r'): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 1; i <= n; i += 1) {
    out.push({ role: 'user', content: `${prefix}${i}-用户` });
    out.push({ role: 'assistant', content: `${prefix}${i}-ThatPerson` });
  }
  return out;
}

test('parseSnapshot：新格式按 ## 用户 / ## ThatPerson 分块且跳过 frontmatter', () => {
  const md = [
    '---',
    'id: session_20260825_143022',
    'title: 测试会话',
    'created_at: 2026-08-25T14:30:22+08:00',
    'updated_at: 2026-08-25T14:45:10+08:00',
    'summary: 测试',
    '---',
    '',
    '## 用户',
    '今天状态怎么样？',
    '',
    '## ThatPerson',
    '还不错，刚写完一段代码。',
    '',
    '## 用户',
    '那周末有计划吗？',
    '',
    '## ThatPerson',
    '想去看书。',
  ].join('\n');
  const msgs = parseSnapshot(md);
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs[0], { role: 'user', content: '今天状态怎么样？' });
  assert.deepEqual(msgs[1], { role: 'assistant', content: '还不错，刚写完一段代码。' });
  assert.deepEqual(msgs[2], { role: 'user', content: '那周末有计划吗？' });
  assert.deepEqual(msgs[3], { role: 'assistant', content: '想去看书。' });
});

test('parseSnapshot：兼容旧格式 **用户**：/**ThatPerson**：', () => {
  const md = [
    '# 会话快照 · 2026-08-25 14:30:22',
    '',
    '- 消息数：4',
    '',
    '## 对话记录',
    '',
    '**用户**：你好',
    '',
    '**ThatPerson**：你好，有什么可以帮你？',
    '',
    '**用户**：帮我查一下天气',
    '',
    '**ThatPerson**：好的，今天晴天。',
  ].join('\n');
  const msgs = parseSnapshot(md);
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs[0], { role: 'user', content: '你好' });
  assert.deepEqual(msgs[1], { role: 'assistant', content: '你好，有什么可以帮你？' });
  assert.deepEqual(msgs[2], { role: 'user', content: '帮我查一下天气' });
  assert.deepEqual(msgs[3], { role: 'assistant', content: '好的，今天晴天。' });
});

test('parseSnapshot：空/无消息返回空数组', () => {
  assert.deepEqual(parseSnapshot(''), []);
  assert.deepEqual(parseSnapshot('---\nid: x\n---\n\n只有标题，没有对话'), []);
});

test('foldToRecovered：保留最近 8 条（4 轮），更早折进 summary', () => {
  const msgs = rounds(5, '轮'); // 10 条 = 5 轮
  const rec = foldToRecovered(msgs);
  assert.equal(rec.history.length, 8, '默认 historyLimit=8');
  assert.deepEqual(rec.history[0], { role: 'user', content: '轮2-用户' });
  assert.deepEqual(rec.history[7], { role: 'assistant', content: '轮5-ThatPerson' });
  assert.match(rec.summary, /用户：轮1-用户/);
  assert.match(rec.summary, /ThatPerson：轮1-ThatPerson/);
  assert.ok(!rec.summary.includes('轮2-用户'), '保留窗口内的轮次不应进 summary');
});

test('foldToRecovered：消息不超过上限时 summary 为空', () => {
  const rec = foldToRecovered(rounds(4));
  assert.equal(rec.history.length, 8);
  assert.equal(rec.summary, '');
});

test('foldToRecovered：summary 超 summaryCharLimit 截断', () => {
  const msgs = rounds(5, '超长轮');
  const rec = foldToRecovered(msgs, { historyLimit: 4, summaryCharLimit: 50 });
  assert.equal(rec.history.length, 4);
  assert.ok(rec.summary.length <= 50, `summary 长度 ${rec.summary.length} 应 ≤ 50`);
  assert.match(rec.summary, /折叠/);
});

function writeSnapshotFile(historyDir: string, file: string, fm?: Record<string, string>): void {
  const sessionsDir = path.join(historyDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const head = fm
    ? ['---', ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n')
    : '';
  fs.writeFileSync(path.join(sessionsDir, file), `${head}## 用户\n你好\n\n## ThatPerson\n你好呀\n`, 'utf8');
}

test('rebuildIndex：扫描 session_*.md 并读 frontmatter', () => {
  const historyDir = caseDir('h-rebuild');
  writeSnapshotFile(historyDir, 'session_20260825_143022.md', {
    id: 'session_20260825_143022',
    title: '第一段',
    created_at: '2026-08-25T14:30:22+08:00',
  });
  writeSnapshotFile(historyDir, 'session_20260826_091201.md', {
    id: 'session_20260826_091201',
    title: '第二段',
    created_at: '2026-08-26T09:12:01+08:00',
  });
  const metas = rebuildIndex(historyDir);
  assert.equal(metas.length, 2);
  assert.equal(metas[0].id, 'session_20260826_091201', '新会话在前');
  assert.equal(metas[0].title, '第二段');
  assert.equal(metas[1].file, 'session_20260825_143022.md');
});

test('listSessions：索引缺失时全量扫描重建并回写，且重建一致', () => {
  const historyDir = caseDir('h-list-missing');
  writeSnapshotFile(historyDir, 'session_20260825_143022.md', {
    id: 'session_20260825_143022',
    title: '会话一',
    created_at: '2026-08-25T14:30:22+08:00',
  });
  writeSnapshotFile(historyDir, 'session_20260826_091201.md', {
    id: 'session_20260826_091201',
    title: '会话二',
    created_at: '2026-08-26T09:12:01+08:00',
  });
  const indexPath = path.join(historyDir, 'sessions', 'index.json');
  assert.ok(!fs.existsSync(indexPath), '前置：索引不存在');

  const first = listSessions(historyDir);
  assert.equal(first.length, 2);
  assert.ok(fs.existsSync(indexPath), '缺失索引应回写');

  const second = listSessions(historyDir);
  assert.deepEqual(second, first, '重建结果与后续读取一致');
});

test('listSessions：索引损坏时同样重建回写', () => {
  const historyDir = caseDir('h-list-corrupt');
  writeSnapshotFile(historyDir, 'session_20260827_100000.md', {
    id: 'session_20260827_100000',
    title: '损坏索引后',
    created_at: '2026-08-27T10:00:00+08:00',
  });
  const indexPath = path.join(historyDir, 'sessions', 'index.json');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, '{ 这不是合法 JSON', 'utf8');
  const metas = listSessions(historyDir);
  assert.equal(metas.length, 1);
  assert.equal(metas[0].id, 'session_20260827_100000');
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { sessions: unknown[] };
  assert.equal(raw.sessions.length, 1, '损坏索引应被重建覆盖');
});

test('loadSession：恢复后 history 含前情内容', () => {
  const historyDir = caseDir('h-load');
  const md = [
    '---',
    'id: session_20260827_120000',
    'title: 恢复测试',
    'created_at: 2026-08-27T12:00:00+08:00',
    '---',
    '',
    '## 用户',
    '前情：我喜欢传统拿铁',
    '',
    '## ThatPerson',
    '记住了，下次帮你点传统拿铁。',
    '',
    '## 用户',
    '今天聊点别的',
    '',
    '## ThatPerson',
    '好啊。',
  ].join('\n');
  const sessionsDir = path.join(historyDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'session_20260827_120000.md'), md, 'utf8');

  const rec = loadSession('session_20260827_120000', historyDir);
  assert.equal(rec.history.length, 4);
  assert.match(rec.history[0].content, /前情/);
  assert.match(rec.history[1].content, /传统拿铁/);
  assert.equal(rec.summary, '');
});

test('titleSnapshot：改 frontmatter title 并同步 index.json', () => {
  const historyDir = caseDir('h-title');
  writeSnapshotFile(historyDir, 'session_20260827_130000.md', {
    id: 'session_20260827_130000',
    title: '旧标题',
    created_at: '2026-08-27T13:00:00+08:00',
  });
  listSessions(historyDir); // 先建索引

  titleSnapshot('session_20260827_130000', '新标题', historyDir);
  const file = path.join(historyDir, 'sessions', 'session_20260827_130000.md');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /^title: 新标题$/m, 'frontmatter title 应更新');
  assert.match(content, /^updated_at:/m, '应同步 updated_at');

  const metas = listSessions(historyDir);
  const entry = metas.find((s) => s.id === 'session_20260827_130000');
  assert.ok(entry, '索引中应存在该会话');
  assert.equal(entry?.title, '新标题');
});

test('titleSnapshot：无 frontmatter 的快照也能补全 title', () => {
  const historyDir = caseDir('h-title-nofm');
  writeSnapshotFile(historyDir, 'session-20260827_140000.md'); // 无 frontmatter（旧 /save 格式）
  titleSnapshot('session-20260827_140000', '补全标题', historyDir);
  const content = fs.readFileSync(path.join(historyDir, 'sessions', 'session-20260827_140000.md'), 'utf8');
  assert.match(content, /^---$/m);
  assert.match(content, /^title: 补全标题$/m);
  assert.match(content, /^id: session-20260827_140000$/m);
});

test('upsertSessionMeta：缺失索引先重建再登记；同 id 不重复、更新原位', () => {
  const historyDir = caseDir('h-upsert');
  // 既有快照（无索引）
  writeSnapshotFile(historyDir, 'session_20260825_090000.md', {
    id: 'session_20260825_090000',
    title: '旧会话',
    created_at: '2026-08-25T09:00:00+08:00',
  });
  // 登记新快照：索引缺失 → 重建 + 追加
  upsertSessionMeta(historyDir, {
    id: 'session_20260827_150000',
    title: '新会话',
    created_at: '2026-08-27T15:00:00+08:00',
    file: 'session_20260827_150000.md',
  });
  const indexPath = path.join(historyDir, 'sessions', 'index.json');
  assert.ok(fs.existsSync(indexPath), '缺失索引应创建');
  let raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { sessions: Array<{ id: string; title: string }> };
  assert.equal(raw.sessions.length, 2, '既有快照应被重建保留');
  assert.equal(raw.sessions[0].id, 'session_20260827_150000', '新会话应在最前');
  // 同 id 再次登记 → 不重复、更新 title
  upsertSessionMeta(historyDir, {
    id: 'session_20260827_150000',
    title: '改名了',
    created_at: '2026-08-27T15:00:00+08:00',
    file: 'session_20260827_150000.md',
  });
  raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { sessions: Array<{ id: string; title: string }> };
  assert.equal(raw.sessions.length, 2, '同 id 不得重复登记');
  const entry = raw.sessions.find((s) => s.id === 'session_20260827_150000');
  assert.equal(entry?.title, '改名了', '同 id 应原位更新 title');
});
