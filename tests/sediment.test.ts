/**
 * 记忆沉淀测试（第 7 期批次三 T11b · D-4 红侧先行；S-1~S-6，KS-7.27）
 *
 * 契约（D-3b 按此实现，src/sediment.ts 为签名壳；archive.ts assistantText 修复亦属 D-3b）：
 * - S-1 提案卡：读入 vault fixture 个人文件 → 抽屉/提炼/source:file/evidence(路径+行区间)/置信度；
 * - S-2 确认桩 true → 落 insights/patterns.md 且条目含 source:file + evidence 行区间；
 * - S-3 铁律：profile/identity 零新增——source:file 永不进 profile（防虚拟幻象）；
 * - S-4 拒绝 → history 无任何写入（不落盘）；
 * - S-5 assistantText 修复：回复含用户陈述 → source:dialog 条目且与 userText 条目去重
 *   （先写「当前死参行为」红断言：现状 extractArchives 只解析 userText，assistantText 是死参）；
 * - S-6 会话摘要聚合：/save 产物含多轮 + 工具统计（路径/主题词无全文）+「读过但未沉淀」提示。
 *
 * 全部离线零 Key；确认桩经 setSedimentConfirmHandler 注入（D-3b 提供实现）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  proposeFromTurn,
  setSedimentConfirmHandler,
  commitSediment,
  type SedimentProposal,
} from '../src/sediment';
import { extractArchives } from '../src/parser/archive';
import { saveSessionSnapshot, type SessionState } from '../src/cli';
import { isolateHome, snapshotTree, assertTreeUnchanged } from './helpers';
import { createVaultFixture, type VaultFixture } from './mocks';

const iso = isolateHome();
test.after(() => iso.restore());

const HISTORY_DIR = path.join(iso.home, 'history');

/** 在项目外造 vault fixture（个人文件样本：日记/小说/笔记） */
function newVault(prefix: string): VaultFixture {
  return createVaultFixture(fs.mkdtempSync(path.join(iso.home, prefix)));
}

/** 读 fixture 文件为工具结果形态 */
function readResult(fixture: VaultFixture, tool = 'read_file'): { tool: string; path: string; content: string } {
  return { tool, path: fixture.diary, content: fs.readFileSync(fixture.diary, 'utf8') };
}

// ===== S-1：提案卡 =====

test('S-1 提案卡：读入个人文件 → 抽屉/提炼/source:file/evidence 路径+行区间/置信度齐全', async () => {
  const fixture = newVault('sediment-s1-');
  const proposals = await proposeFromTurn({
    toolResults: [readResult(fixture)],
    assistantText: '这本 1987 年的诗集听起来很有年代感！你常去旧书市集吗？',
  });
  assert.ok(Array.isArray(proposals) && proposals.length >= 1, '读入个人文件后应产出至少 1 张提案卡');
  for (const p of proposals) {
    assert.ok(['insights', 'profile'].includes(p.drawer), `抽屉应为 insights|profile，实际：${p.drawer}`);
    assert.ok(typeof p.insight === 'string' && p.insight.trim().length > 0, '提案卡应含提炼信息');
    assert.ok(['高', '中', '低'].includes(p.confidence), `置信度应为 高/中/低，实际：${p.confidence}`);
    if (p.source === 'file') {
      assert.ok(p.evidence, 'source:file 提案必须带 evidence');
      assert.equal(
        path.resolve((p.evidence as { path: string }).path).toLowerCase(),
        path.resolve(fixture.diary).toLowerCase(),
        'evidence.path 应指向被读的源文件',
      );
      assert.ok(
        p.evidence!.lineStart >= 1 && p.evidence!.lineEnd >= p.evidence!.lineStart,
        `evidence 行区间应合法（1 起、end≥start），实际：${p.evidence!.lineStart}-${p.evidence!.lineEnd}`,
      );
    }
  }
  const fileProposal = proposals.find((p) => p.source === 'file');
  assert.ok(fileProposal, '读类工具结果应产出 source:file 提案');
  assert.equal(fileProposal!.drawer, 'insights', 'source:file 提案的抽屉必须是 insights（铁律）');
});

// ===== S-2：确认落盘 insights/ =====

test('S-2 确认桩 true → 落 insights/patterns.md，条目含 source:file + evidence 行区间', async () => {
  const fixture = newVault('sediment-s2-');
  const proposal: SedimentProposal = {
    drawer: 'insights',
    insight: '用户淘到过 1987 年的绝版诗集，对旧书市集有稳定兴趣。',
    source: 'file',
    evidence: { path: fixture.diary, lineStart: 2, lineEnd: 4 },
    confidence: '高',
  };
  setSedimentConfirmHandler(() => true);
  try {
    const res = await commitSediment([proposal], { historyDir: HISTORY_DIR, isMock: true });
    assert.equal(res.confirmed, true, '确认桩 true 应视为已确认');
    assert.ok(res.written.some((w) => w.replace(/\\/g, '/').includes('insights/patterns.md')), '应落 insights/patterns.md');
    const patterns = fs.readFileSync(path.join(HISTORY_DIR, 'insights', 'patterns.md'), 'utf8');
    assert.ok(patterns.includes('source:file'), '落盘条目应标注 source:file');
    assert.ok(patterns.includes(path.basename(fixture.diary)), '落盘条目应含 evidence 文件路径');
    assert.ok(/#L2-L4|L2[-~]L4|#L2/.test(patterns), `落盘条目应含 evidence 行区间（L2-L4 口径），实际：${patterns.slice(0, 400)}`);
    assert.ok(patterns.includes('绝版诗集'), '落盘条目应含提炼信息');
  } finally {
    setSedimentConfirmHandler(null);
  }
});

// ===== S-3：铁律——profile/identity 零新增 =====

test('S-3 铁律：source:file 提案即使带 profile 抽屉也绝不写入 profile/（防虚拟幻象零污染）', async () => {
  const fixture = newVault('sediment-s3-');
  const profileDir = path.join(HISTORY_DIR, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'identity.md'), '# 身份\n（既有身份，不得被 source:file 污染）\n', 'utf8');
  const before = snapshotTree(profileDir);
  // 对抗性提案：source:file 却声明 drawer=profile —— 实现必须拒绝/改写，profile 零新增
  const adversarial: SedimentProposal = {
    drawer: 'profile',
    insight: '小说人物林晚记录开片纹理（虚构内容，绝不能进画像）。',
    source: 'file',
    evidence: { path: fixture.novel, lineStart: 1, lineEnd: 3 },
    confidence: '高',
  };
  setSedimentConfirmHandler(() => true);
  try {
    await commitSediment([adversarial], { historyDir: HISTORY_DIR, isMock: true });
    assertTreeUnchanged(before, profileDir);
    assert.ok(!fs.existsSync(path.join(profileDir, 'traits.md')), 'traits.md 不得被 source:file 创建');
  } finally {
    setSedimentConfirmHandler(null);
  }
});

// ===== S-4：拒绝不落盘 =====

test('S-4 确认桩拒绝 → history 无任何写入（提案全部丢弃）', async () => {
  const fixture = newVault('sediment-s4-');
  const historyExisted = fs.existsSync(HISTORY_DIR);
  const before = historyExisted ? snapshotTree(HISTORY_DIR) : null;
  const proposal: SedimentProposal = {
    drawer: 'insights',
    insight: '用户对旧书市集有稳定兴趣（本条应被拒绝丢弃）。',
    source: 'file',
    evidence: { path: fixture.diary, lineStart: 1, lineEnd: 2 },
    confidence: '中',
  };
  setSedimentConfirmHandler(() => false);
  try {
    const res = await commitSediment([proposal], { historyDir: HISTORY_DIR, isMock: true });
    assert.equal(res.confirmed, false, '确认桩 false 应视为未确认');
    assert.equal(res.written.length, 0, '拒绝后不得有落盘文件');
    if (before === null) {
      assert.ok(!fs.existsSync(HISTORY_DIR), 'history 原不存在时拒绝后也不得创建');
    } else {
      assertTreeUnchanged(before, HISTORY_DIR);
    }
  } finally {
    setSedimentConfirmHandler(null);
  }
});

// ===== S-5：assistantText 死参修复（先写「当前死参行为」红断言）=====

test('S-5 assistantText 纳入解析：回复含用户陈述 → source:dialog 条目且与 userText 条目去重', () => {
  const userText = '我不喜欢喝咖啡。';
  const assistantText = '好的，我记住了。你提到你更喜欢喝茶，回头给你推荐几款花草茶。';
  const archives = extractArchives(userText, assistantText);
  // 1) 回复中的新陈述（更喜欢喝茶）应产出条目 —— 现状死参：assistantText 被忽略 → 红
  const fromReply = archives.find((a) => a.insight.includes('茶'));
  assert.ok(fromReply, `assistantText 中的用户陈述应被解析（当前死参行为 → 红），实际：${JSON.stringify(archives.map((a) => a.insight))}`);
  assert.equal(
    (fromReply as { source?: string }).source,
    'dialog',
    '由对话（含回复）解析的条目应标注 source:dialog（profile 收录依据）',
  );
  // 2) 去重：userText 与 assistantText 重复陈述（不喜欢咖啡）只产出一条
  const dupes = archives.filter((a) => a.type === '偏好' && a.insight.includes('不喜欢'));
  assert.equal(dupes.length, 1, `重复陈述应去重为 1 条，实际：${dupes.length} 条`);
});

// ===== S-6：会话摘要聚合（/save 产物）=====

test('S-6 /save 产物会话聚合：多轮 + 工具统计（路径无全文）+「读过但未沉淀」提示', () => {
  const fixture = newVault('sediment-s6-');
  const diaryContent = fs.readFileSync(fixture.diary, 'utf8');
  // 多轮会话（3 轮）+ 本会话工具活动记录（SessionState 增量字段，D-3b 落地）
  const session = {
    history: [
      { role: 'user' as const, content: '帮我看看我昨天写的日记（轮一）。' },
      { role: 'assistant' as const, content: '好呀，我来读一下。' },
      { role: 'user' as const, content: '日记里那本诗集我还想再聊聊（轮二）。' },
      { role: 'assistant' as const, content: '1987 年的诗集确实有味道。' },
      { role: 'user' as const, content: '周末想去旧书市集逛逛（轮三）。' },
      { role: 'assistant' as const, content: '记得带我云逛一下。' },
    ],
    summary: '',
    recentUserTexts: [],
    // 本会话工具活动：读过但未沉淀（sedimented:false）→ 摘要必须显式提示
    toolActivity: [
      { tool: 'read_file', target: fixture.diary, ok: true, sedimented: false },
      { tool: 'read_vault_note', target: '2026-08-01', ok: true, sedimented: true },
    ],
  } as unknown as SessionState;

  const file = saveSessionSnapshot(session, HISTORY_DIR);
  const md = fs.readFileSync(file, 'utf8');
  // 多轮精炼：三轮用户消息都在
  assert.ok(md.includes('轮一') && md.includes('轮二') && md.includes('轮三'), '快照应聚合多轮对话');
  // 工具统计：只记路径/主题词，不含文件全文
  assert.ok(md.includes('工具活动'), '快照应含工具活动统计段');
  assert.ok(md.includes(path.basename(fixture.diary)), '工具统计应含读过文件的路径');
  assert.ok(!md.includes('旧书市集，淘到一本'), '工具统计不得携带文件全文（隐私口径）');
  assert.ok(!md.includes(diaryContent.trim().slice(0, 30)), '快照不得全文粘贴读过的文件内容');
  // 「读过但未沉淀」显式提示
  assert.ok(md.includes('读过但未沉淀'), '读过但未沉淀的工具活动应显式提示');
});
