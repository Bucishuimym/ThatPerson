/**
 * 检索增强单元测试（第 7 期批次三 T11 · D-4 红侧先行；R-2~R-6，KS-7.27）
 *
 * 契约（D-3a 按此实现，src/retrieval.ts 为签名壳）：
 * - R-2 统一打分：同相关性下罕见词（IDF 高）得分 > 常见词；标签与词法**同公式竞争**（废除先到先得瀑布）；
 * - R-3 排序：时间衰减（新条目 > 旧条目）× 置信度权重（高 1.0/中 0.7/低 0.4）；
 * - R-4 持久化倒排索引：append 后指纹变化增量可查；删索引文件后 rebuildIndex 与原查询结果一致；
 * - R-5 截断蒸馏：__setDistillImpl 注入桩 → 长命中蒸馏后注入 ≤ 预算 + 台账行 kind='distill'
 *   + 净省判据（桩开销过大回退直截断）；
 * - R-6 名实一致：RETRIEVE_LAYER_CHAR_LIMIT=1200（clip 字符断言），RETRIEVE_LAYER_BUDGET 别名仍可用。
 *
 * 全部离线零 Key：语料经 isolateHome 写临时 history/ 五维文件；蒸馏/检索全走注入桩。
 * 红侧现状：searchScored/rebuildIndex/ensureIndexFresh/__setDistillImpl/assembleInjection 均为
 * not-implemented 壳 → R-2~R-5 红；R-6 常量与现状 clip 行为可绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  searchScored,
  rebuildIndex,
  __setDistillImpl,
  assembleInjection,
  RETRIEVE_LAYER_CHAR_LIMIT,
  RETRIEVE_LAYER_BUDGET,
  type ScoredHit,
} from '../src/retrieval';
import { retrieveRelevant, getMonthlyTokenUsage, RETRIEVE_LAYER_BUDGET as CHAT_LAYER_BUDGET } from '../src/chat';
import type { LoadedMemories } from '../src/memory/types';
import { isolateHome } from './helpers';

const iso = isolateHome();
test.after(() => iso.restore());

/** 语料根：history/ 目录（对齐 createMemoryStore(root) 的 historyDir 口径） */
function newHistoryDir(prefix: string): string {
  const dir = path.join(fs.mkdtempSync(path.join(iso.home, prefix)), 'history');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeHistoryFile(historyDir: string, rel: string, lines: string[]): string {
  const target = path.join(historyDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  return target;
}

/** 从命中列表按子串取首个命中（找不到返回 undefined） */
function hitBy(hits: ScoredHit[], needle: string): ScoredHit | undefined {
  return hits.find((h) => h.text.includes(needle));
}

// ===== R-2：统一打分（罕见词 > 常见词；标签与词法同公式竞争）=====

test('R-2a 同相关性下罕见词得分 > 常见词（IDF 按语料统计）', () => {
  const dir = newHistoryDir('r2a-');
  // 常见词「咖啡」散布 5 段（IDF 低）；罕见词「绝版」仅 1 段（IDF 高）
  writeHistoryFile(dir, 'profile/preferences.md', [
    '- 用户喜欢喝咖啡，常去公司楼下的咖啡馆。',
    '- 用户习惯早上喝一杯咖啡再开工。',
    '- 用户周末会去咖啡馆坐一下午。',
    '- 用户提到咖啡豆偏好浅烘。',
    '- 用户不喜欢空腹喝咖啡。',
    '- 书架深处收着一册绝版诗集，作者签名本，舍不得外借。',
  ]);
  // 查询同时含罕见词与常见词：两类段落都直接命中查询词（同相关性）
  const hits = searchScored('绝版诗集 和 咖啡 的偏好', dir);
  const rare = hitBy(hits, '绝版');
  const common = hits.find((h) => h.text.includes('咖啡') && !h.text.includes('绝版'));
  assert.ok(rare, `应命中罕见词段落，实际：${JSON.stringify(hits.map((h) => h.text.slice(0, 40)))}`);
  assert.ok(common, '应命中常见词段落');
  assert.ok(
    (rare as ScoredHit).score > (common as ScoredHit).score,
    `罕见词命中得分应高于常见词命中，实际 rare=${(rare as ScoredHit).score} common=${(common as ScoredHit).score}`,
  );
});

test('R-2b 标签与词法同公式竞争：标签孤立命中不压制词法密集命中（废除先到先得瀑布）', () => {
  const dir = newHistoryDir('r2b-');
  writeHistoryFile(dir, 'profile/preferences.md', [
    '- 今天天气不错，出门散步了。#咖啡',
    '- 用户每天喝两杯咖啡，咖啡豆自己烘，还研究过手冲水温与粉水比。',
  ]);
  const hits = searchScored('咖啡', dir);
  const tagOnly = hitBy(hits, '散步'); // 仅 #咖啡 标签命中、正文与咖啡无关
  const lexical = hitBy(hits, '咖啡豆'); // 词法密集命中
  assert.ok(tagOnly, '标签命中段落应入池（同公式而非排除）');
  assert.ok(lexical, '词法命中段落应入池');
  assert.ok(
    (lexical as ScoredHit).score > (tagOnly as ScoredHit).score,
    `词法密集命中得分应高于标签孤立命中，实际 lexical=${(lexical as ScoredHit).score} tagOnly=${(tagOnly as ScoredHit).score}`,
  );
});

// ===== R-3：时间衰减 × 置信度排序 =====

test('R-3a 时间衰减：同置信度同词频下，新条目得分 > 旧条目（指数衰减，LOW_CONFIDENCE_TTL_DAYS 量级）', () => {
  const dir = newHistoryDir('r3a-');
  writeHistoryFile(dir, 'experiences/journal.md', [
    '## 2026-08-28',
    '',
    '### [归档类型：经历]',
    '',
    '- **原始对话片段**：「周末去莫干山徒步爬山，很畅快」',
    '- **提炼信息**：用户近期去莫干山爬山，感受畅快。',
    '- **置信度**：高',
    '- **关联标签**：#运动 #爬山',
    '',
    '## 2026-05-02',
    '',
    '### [归档类型：经历]',
    '',
    '- **原始对话片段**：「五一前去佘山爬山，人很多」',
    '- **提炼信息**：用户曾去佘山爬山。',
    '- **置信度**：高',
    '- **关联标签**：#运动 #爬山',
  ]);
  const hits = searchScored('爬山', dir);
  const recent = hitBy(hits, '莫干山');
  const older = hitBy(hits, '佘山');
  assert.ok(recent && older, '两个条目都应命中');
  assert.ok(
    (recent as ScoredHit).score > (older as ScoredHit).score,
    `时间近因得分应更高，实际 recent=${(recent as ScoredHit).score} older=${(older as ScoredHit).score}`,
  );
});

test('R-3b 置信度权重：同时间同词频下，高置信条目得分 > 低置信条目', () => {
  const dir = newHistoryDir('r3b-');
  writeHistoryFile(dir, 'experiences/journal.md', [
    '## 2026-08-20',
    '',
    '### [归档类型：经历]',
    '',
    '- **原始对话片段**：「每周三都去游泳馆夜游，很解压」',
    '- **提炼信息**：用户坚持每周夜游，运动习惯稳定。',
    '- **置信度**：高',
    '- **关联标签**：#运动 #游泳',
    '',
    '## 2026-08-20',
    '',
    '### [归档类型：经历]',
    '',
    '- **原始对话片段**：「好像小时候学过游泳」',
    '- **提炼信息**：用户可能学过游泳，单次暗示。',
    '- **置信度**：低',
    '- **关联标签**：#运动 #游泳',
  ]);
  const hits = searchScored('游泳', dir);
  const high = hitBy(hits, '夜游');
  const low = hitBy(hits, '小时候');
  assert.ok(high && low, '两个条目都应命中');
  assert.ok(
    (high as ScoredHit).score > (low as ScoredHit).score,
    `高置信得分应更高，实际 high=${(high as ScoredHit).score} low=${(low as ScoredHit).score}`,
  );
});

// ===== R-4：持久化倒排索引（增量可查 + 重建一致）=====

test('R-4 append 后指纹变化增量可查（零写入路径改动、无需显式重建）', () => {
  const dir = newHistoryDir('r4a-');
  writeHistoryFile(dir, 'profile/preferences.md', ['- 用户喜欢喝咖啡，常去公司楼下的咖啡馆。']);
  const before = searchScored('越剧', dir);
  assert.ok(!before.some((h) => h.text.includes('越剧')), '新内容写入前不应命中「越剧」');
  // 直接 append 历史文件（模拟 appendArchive 的零改动写入路径）
  writeHistoryFile(dir, 'profile/preferences.md', [
    '- 用户喜欢喝咖啡，常去公司楼下的咖啡馆。',
    '- 看了一场越剧《梁祝》，很感动，想再去一次。',
  ]);
  const after = searchScored('越剧', dir);
  assert.ok(
    after.some((h) => h.text.includes('越剧')),
    'append 后经指纹增量重索引应可查「越剧」',
  );
});

test('R-4 删索引文件后 rebuildIndex 全量重建，原查询结果一致', () => {
  const dir = newHistoryDir('r4b-');
  writeHistoryFile(dir, 'profile/preferences.md', [
    '- 用户喜欢喝咖啡，常去公司楼下的咖啡馆。',
    '- 周末喜欢逛旧书市集淘绝版诗集。',
  ]);
  writeHistoryFile(dir, 'insights/patterns.md', ['- 用户近期熬夜频率高。#作息 #模式']);
  const first = searchScored('咖啡', dir).map((h) => [h.source, h.text] as const);
  assert.ok(first.length > 0, '删索引前应有命中');
  // 删除索引文件 → rebuildIndex → 同查询结果一致
  fs.rmSync(path.join(dir, 'index'), { recursive: true, force: true });
  rebuildIndex(dir);
  const second = searchScored('咖啡', dir).map((h) => [h.source, h.text] as const);
  assert.deepEqual(second, first, '重建索引后同查询的命中（source+text）应与原结果一致');
});

// ===== R-5：截断蒸馏（注入桩 + 台账 kind='distill' + 净省回退）=====

test('R-5 蒸馏：注入桩后长命中蒸馏 ≤ 预算 + 台账 kind=distill；桩开销过大回退直截断', async () => {
  const dir = newHistoryDir('r5-');
  // 一段 ~900 字长文 + 若干短命中，总量超 RETRIEVE_LAYER_CHAR_LIMIT 触发预算外蒸馏
  const longText = `用户聊起咖啡的由来、豆种、烘焙曲线与水温实验：${'咖啡风味随烘焙度变化，浅烘偏果酸，深烘偏醇苦。'.repeat(30)}`;
  writeHistoryFile(dir, 'profile/preferences.md', [
    longText,
    '- 用户喜欢喝咖啡，常去公司楼下的咖啡馆。',
    '- 周末喜欢逛旧书市集淘绝版诗集。',
  ]);
  const budget = RETRIEVE_LAYER_CHAR_LIMIT;
  // 桩 1：蒸馏便宜 → 走蒸馏，产物标注「（摘要）」，注入 ≤ 预算，台账记 kind='distill'
  __setDistillImpl(async (text, ctx) => ({
    summary: '（摘要）用户研究咖啡烘焙与水温实验，偏好浅烘豆。',
    promptTokens: Math.ceil(text.length / 4),
    completionTokens: 20,
  }));
  try {
    const cheap = await assembleInjection('咖啡', dir, { budgetChars: budget });
    assert.ok(cheap.injection.length <= budget, `注入应 ≤ 预算 ${budget}，实际 ${cheap.injection.length}`);
    assert.ok(cheap.injection.includes('（摘要）'), '蒸馏产物应标注「（摘要）」');
    assert.ok(cheap.distilledCount >= 1, '应至少蒸馏 1 条长命中');
    assert.equal(cheap.fellBack, false, '蒸馏便宜时不应回退');
    const ledger = getMonthlyTokenUsage();
    assert.ok(
      ledger.records.some((r) => (r as { kind?: string }).kind === 'distill'),
      '台账应出现 kind=distill 的行（TokenUsageRecord 增可选 kind）',
    );

    // 桩 2：蒸馏开销巨大 → 净省判据触发回退直截断（无「（摘要）」标注）
    __setDistillImpl(async () => ({
      summary: '（摘要）这一段太贵了不该被采用。',
      promptTokens: 5_000_000,
      completionTokens: 5_000_000,
    }));
    const expensive = await assembleInjection('咖啡', dir, { budgetChars: budget });
    assert.equal(expensive.fellBack, true, '桩开销 ≥ 注入节省时应回退直截断');
    assert.ok(!expensive.injection.includes('（摘要）'), '回退路径不得混入蒸馏产物');
    assert.ok(expensive.injection.length <= budget + 1, '回退后注入仍 ≤ 预算（clip 容忍省略号 1 字符）');
  } finally {
    __setDistillImpl(null); // 恢复缺省（无桩=直截断）
  }
});

// ===== R-6：口径名实一致（CHAR_LIMIT 真名 + BUDGET 兼容别名 + 行为=字符截断）=====

test('R-6 RETRIEVE_LAYER_CHAR_LIMIT=1200 存在且行为=字符截断；RETRIEVE_LAYER_BUDGET 别名仍可用', () => {
  // 名实一致：新常量存在，兼容别名同值
  assert.equal(RETRIEVE_LAYER_CHAR_LIMIT, 1200);
  assert.equal(RETRIEVE_LAYER_BUDGET, RETRIEVE_LAYER_CHAR_LIMIT, '别名应与新常量同值');
  assert.equal(CHAT_LAYER_BUDGET, RETRIEVE_LAYER_CHAR_LIMIT, 'chat.ts 既有导出应与 CHAR_LIMIT 同值（行为不变）');
  // 行为=字符截断：现状 retrieveRelevant 注入串超预算时按字符 clip（…结尾），不丢层
  const longLine = `- 用户喜欢喝咖啡，第 N 次记录，条目内容足够长以撑爆预算。${'细节填充内容，咖啡参数各不相同。'.repeat(8)}`;
  const memories: LoadedMemories = {
    profile: { 'preferences.md': Array.from({ length: 20 }, (_, i) => longLine.replace('第 N 次', `第 ${i} 次`)).join('\n\n') },
    importantDates: null,
    patterns: null,
    recentSessions: [],
  };
  const result = retrieveRelevant('咖啡', memories, []);
  assert.ok(result.length > 0, '应命中');
  assert.ok(
    result.length <= RETRIEVE_LAYER_CHAR_LIMIT + 1,
    `注入串应按 ${RETRIEVE_LAYER_CHAR_LIMIT} 字符截断（容忍省略号），实际 ${result.length}`,
  );
  assert.ok(result.endsWith('…'), '截断行为应以省略号结尾（clip 语义）');
});
