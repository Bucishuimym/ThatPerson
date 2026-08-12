/**
 * Bad Case 回归测试（QA/评估子代理产出，O-1 落地）
 *
 * 覆盖第三版提示词 3e 验收清单 BC-1 ~ BC-6。
 * 接口假设（对齐当前 src 实现）：
 * - extractArchives(userText, assistantText)：单条消息不产出「模式」，跨轮走 detectCrossTurnPatterns；
 * - detectCrossTurnPatterns(userTexts: string[])：跨 ≥2 轮/天 才产出「模式」；
 * - buildSystemPrompt：分层注入 + 长度预算；
 * - estimateTokens / SYSTEM_TOKEN_BUDGET / foldSummary / SUMMARY_CHAR_LIMIT：src/chat.ts 导出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractArchives, detectCrossTurnPatterns } from '../src/parser/archive';
import {
  buildSystemPrompt,
  estimateTokens,
  foldSummary,
  SUMMARY_CHAR_LIMIT,
  SYSTEM_TOKEN_BUDGET,
} from '../src/chat';
import { createMemoryStore } from '../src/memory/store';
import type { LoadedMemories } from '../src/memory/types';

// ===== BC-1 =====

test('BC-1 经历提取：含「打篮球」、无「用户去啊」残句、回复指令不强制全量扫射', () => {
  const archives = extractArchives('今天去打篮球，好喜欢打篮球', '');
  const exp = archives.find((a) => a.type === '经历' && a.insight.includes('打篮球'));
  assert.ok(
    exp,
    `应提取含「打篮球」的经历条目，实际：${JSON.stringify(archives.map((a) => `${a.type}|${a.insight}`))}`,
  );
  for (const a of archives) {
    assert.ok(
      !(a.insight + a.dialog).includes('用户去啊'),
      `不得产生「用户去啊」式残句，实际：${a.insight}`,
    );
  }
  assert.ok(!archives.some((a) => a.type === '模式'), '单次事件不应被识别为行为模式');

  const sys = buildSystemPrompt({ profile: {}, importantDates: null, patterns: null, recentSessions: [] });
  for (const kw of ['全量', '全部记忆', '回顾所有记忆', '逐条', '遍历所有', '所有记忆内容']) {
    assert.ok(!sys.includes(kw), `回复指令不得强制全量扫射（含「${kw}」）：${sys}`);
  }
  assert.ok(sys.includes('融入'), '回复指令应提示自然融入记忆点，而非机械罗列');
});

// ===== BC-2 =====

test('BC-2 负向偏好：对象回溯到「燕麦拿铁」而非「咖啡馆」场景', () => {
  const archives = extractArchives('今天去楼下咖啡馆试了燕麦拿铁，不太喜欢，还是更喜欢传统拿铁', '');
  const neg = archives.find((a) => a.type === '偏好' && a.insight.includes('不喜欢'));
  assert.ok(
    neg,
    `应提取负向偏好条目，实际：${JSON.stringify(archives.map((a) => `${a.type}|${a.insight}`))}`,
  );
  // 「咖啡馆」允许作为场景出现在 dialog 中，判据是引号内对象回溯正确
  assert.ok(neg!.dialog.includes('咖啡馆'), '咖啡馆可作为原话场景出现在 dialog 中');
  const quoted = neg!.insight.match(/「([^」]*)」/)?.[1] ?? '';
  assert.ok(quoted.includes('燕麦拿铁'), `负向对象应含「燕麦拿铁」，实际对象：${quoted}`);
  assert.ok(!quoted.includes('咖啡馆'), `负向对象不得为「咖啡馆」等场景描述，实际对象：${quoted}`);
});

// ===== BC-3 =====

test('BC-3 回复指令：只融入 ≤1 条与当前话题/情绪相关的记忆', () => {
  const memories: LoadedMemories = {
    profile: { 'preferences.md': '用户喜欢传统拿铁。' },
    importantDates: null,
    patterns: null,
    recentSessions: [],
  };
  const sys = buildSystemPrompt(memories);
  assert.match(sys, /相关/, `回复指令应包含相关性约束关键词「相关」，实际：${sys}`);
  assert.match(
    sys,
    /(最多|不超过|只融入|仅融入|≤)\s*1\s*(条|个)/,
    `应限制最多融入 1 条相关记忆，实际：${sys}`,
  );
});

// ===== BC-4 =====

test('BC-4 同一条消息三次提「咖啡」不得产出「模式」条目（跨轮才判模式）', () => {
  const inputs = [
    '咖啡咖啡咖啡',
    '咖啡、咖啡，还是咖啡',
    '今天喝咖啡，晚上又喝了咖啡，睡前还想来一杯咖啡',
  ];
  for (const input of inputs) {
    const patterns = extractArchives(input, '').filter((a) => a.type === '模式');
    assert.equal(
      patterns.length,
      0,
      `单条消息内多次提及不应判定为行为模式，输入：${input}，` +
        `实际：${JSON.stringify(patterns.map((p) => p.insight))}`,
    );
  }
  // 互补语义：跨轮/跨天多次提及才应产出「模式」
  const cross = detectCrossTurnPatterns(['今天喝了咖啡', '晚上又去喝了一杯咖啡']);
  assert.ok(cross.length >= 1, `跨轮多次提及应产出模式，实际：${JSON.stringify(cross.map((p) => p.insight))}`);
  const single = detectCrossTurnPatterns(['咖啡咖啡咖啡']);
  assert.equal(single.length, 0, '单条消息即使三次提及也不得产出模式');
});

// ===== BC-5 =====

test('BC-5 三个月记忆规模下 System Prompt 长度有上限（≤6000 token 预算）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-bc5-'));
  const store = createMemoryStore(root);
  store.ensureStructure();

  // 3 个月规模：90 天会话日志 + 90 条偏好 + 200 条身份 + 30 条日程 + traits 大文件
  for (let i = 0; i < 90; i += 1) {
    const date = new Date(Date.UTC(2026, 4, 1 + i)).toISOString().slice(0, 10);
    store.appendSessionLog({
      date,
      topics: ['咖啡', '运动'],
      mood: '平静',
      newMemories: ['偏好 | 用户喜欢「拿铁」，明确陈述。 | 高'],
      followUps: ['周末去书店'],
    });
    store.appendArchive('profile', {
      type: '偏好',
      dialog: `今天喝了燕麦拿铁，第${i}次。`,
      insight: `用户喜欢「拿铁」第${i}条，明确陈述。`,
      confidence: '高',
      tags: ['#咖啡', '#饮食偏好'],
    });
  }
  for (let i = 0; i < 200; i += 1) {
    store.appendArchive('profile', {
      type: '身份',
      dialog: `我叫小鹿，来自城市${i}。`,
      insight: `用户身份：城市${i}的小鹿。`,
      confidence: '高',
      tags: ['#身份'],
    });
  }
  const today = new Date();
  for (let i = 0; i < 30; i += 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (i % 14) + 1);
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    store.appendArchive('timeline', {
      type: '日期',
      dialog: `${md}有场面试。`,
      insight: `用户的重要日期：面试（${md}）。`,
      confidence: '高',
      tags: ['#求职'],
    });
  }
  const traitsPath = path.join(root, 'history', 'profile', 'traits.md');
  fs.writeFileSync(traitsPath, '用户性格：认真、慢热、喜欢安静。\n'.repeat(80), 'utf8');

  const memories = await store.load();
  const prompt = buildSystemPrompt(memories);
  assert.ok(prompt.includes('<memory>'), '前置条件：记忆应被注入 System Prompt');

  const tokens = estimateTokens(prompt);
  assert.ok(
    tokens <= SYSTEM_TOKEN_BUDGET,
    `System Prompt 估算 token 应 ≤${SYSTEM_TOKEN_BUDGET}（字符数 ${prompt.length}，估算 ${tokens} token）`,
  );
  // 保守的字符级上限：6000 token ≈ 9000 字符（按 1.5 字符/token），再留 30% 余量
  assert.ok(prompt.length <= 12000, `字符级保险上限 12000 字符，实际 ${prompt.length} 字符`);
});

// ===== BC-6 =====

test('BC-6 summary 二次折叠：超限保留最新部分，总长受限', () => {
  const short = '用户说「今天好累」，你回应「早点休息」。';
  assert.equal(foldSummary(short), short, '未超限时不应改动');

  // 模拟 cli.ts 持续对话：每轮折叠后追加新轮次，再折叠
  const MAX = SUMMARY_CHAR_LIMIT;
  let summary = '';
  const latestUser = '第199轮用户最后说的关键信息XYZ';
  for (let i = 0; i < 200; i += 1) {
    const user = i === 199 ? latestUser : `第${i}轮：用户聊了咖啡、运动和生活，内容较长${'嗯'.repeat(20)}`;
    const reply = `第${i}轮：ThatPerson 的回应内容${'好的'.repeat(20)}`;
    summary = foldSummary(`${summary ? summary + '\n' : ''}用户说「${user}」，你回应「${reply}」`);
    assert.ok(summary.length <= MAX, `折叠后长度应 ≤${MAX}，第 ${i} 轮实际 ${summary.length}`);
  }
  assert.ok(summary.includes('折叠'), '超限时应标记「已折叠」');
  assert.ok(summary.includes(latestUser), '最新一轮内容必须保留');
});

// ===== BC-7 =====

test('BC-7 负向偏好「其实我不喜欢下雨天」只归档负向、无双极性', () => {
  const archives = extractArchives('其实我不喜欢下雨天', '');
  const prefs = archives.filter((a) => a.type === '偏好');
  const neg = prefs.find((a) => a.insight.includes('不喜欢'));
  assert.ok(
    neg,
    `应提取负向偏好条目，实际：${JSON.stringify(archives.map((a) => `${a.type}|${a.insight}`))}`,
  );
  assert.ok(neg!.insight.includes('下雨天'), `负向对象应为「下雨天」，实际：${neg!.insight}`);
  // 否定前置检测：`不 … 喜欢` 不得同时产出正负双极性（第四版提示词 edge_cases）
  const pos = prefs.find((a) => a.insight.includes('喜欢') && !a.insight.includes('不喜欢'));
  assert.ok(!pos, `不得同时产出正向偏好（双极性），实际：${JSON.stringify(prefs.map((p) => p.insight))}`);
  assert.ok(
    !archives.some((a) => a.insight.includes('用户喜欢「下雨天」')),
    '不得出现「用户喜欢下雨天」式正向归档',
  );
});

// ===== BC-8 =====

test('BC-8 疑问句「你记得我喜欢干什么嘛」不归档「喜欢干什么嘛」', () => {
  const archives = extractArchives('你记得我喜欢干什么嘛', '');
  const prefs = archives.filter((a) => a.type === '偏好');
  assert.equal(
    prefs.length,
    0,
    `疑问句不得进入偏好对象（wh-词过滤：干什么/吗/嘛），实际：${JSON.stringify(prefs.map((p) => p.insight))}`,
  );
  for (const a of archives) {
    assert.ok(
      !(a.insight + a.dialog).includes('干什么嘛'),
      `不得归档「喜欢干什么嘛」，实际：${a.insight}`,
    );
  }
});

// ===== BC-9 =====

test('BC-9 不确定性「我都不确定我喜不喜欢上课」无双极性、置信度不标「高」', () => {
  const archives = extractArchives('我都不确定我喜不喜欢上课', '');
  const prefs = archives.filter((a) => a.type === '偏好');
  const neg = prefs.filter((p) => p.insight.includes('不喜欢'));
  const pos = prefs.filter((p) => p.insight.includes('喜欢') && !p.insight.includes('不喜欢'));
  assert.ok(
    !(neg.length > 0 && pos.length > 0),
    `「不确定」表述不得同时产出正负双极性，实际：${JSON.stringify(prefs.map((p) => p.insight))}`,
  );
  for (const p of prefs) {
    assert.notEqual(p.confidence, '高', `不确定表述不得标「高」，实际：${p.insight}（${p.confidence}）`);
    assert.ok(['中', '低'].includes(p.confidence), `不确定表述应降级为「中/低」，实际：${p.confidence}`);
  }
});
