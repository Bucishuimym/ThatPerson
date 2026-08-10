import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractArchives, buildSessionSummary, detectCrossTurnPatterns } from '../src/parser/archive';

test('偏好提取：明确陈述为高置信度，保留对象与标签', () => {
  const archives = extractArchives(
    '今天去试了楼下新开的咖啡馆，我还是更喜欢传统的拿铁，不太喜欢肉桂味。',
    '肉桂拿铁确实是个冒险的选择哈哈。',
  );
  const prefs = archives.filter((a) => a.type === '偏好');
  assert.ok(prefs.length >= 2, '应同时提取正负偏好');
  const pos = prefs.find((a) => a.insight.includes('喜欢'));
  assert.ok(pos, '应提取「更喜欢传统的拿铁」');
  assert.equal(pos.confidence, '高');
  assert.ok(pos.dialog.includes('传统的拿铁'), 'dialog 保留原话上下文');
  assert.ok(pos.tags.includes('#咖啡'));
  assert.ok(pos.tags.includes('#饮食偏好'));
  const neg = prefs.find((a) => a.insight.includes('不喜欢'));
  assert.ok(neg, '应提取「不太喜欢肉桂味」');
  assert.equal(neg.confidence, '高');
});

test('偏好提取：习惯性表述推断为中置信度', () => {
  const archives = extractArchives('我习惯早起，每天都要喝一杯咖啡提神。', '');
  const prefs = archives.filter((a) => a.type === '偏好');
  assert.ok(prefs.length >= 1);
  assert.ok(prefs.every((a) => a.confidence === '中'));
  assert.ok(prefs.some((a) => a.insight.includes('早起')));
});

test('经历提取：行为动词 + 感受词', () => {
  const archives = extractArchives('昨天去看了新上映的电影，特别好看，我很喜欢。', '');
  const exp = archives.find((a) => a.type === '经历');
  assert.ok(exp, '应提取经历条目');
  assert.equal(exp.confidence, '高');
  assert.ok(exp.dialog.includes('昨天去看了新上映的电影'));
  assert.ok(exp.insight.includes('感受'));
  assert.ok(exp.tags.includes('#电影'));
});

test('日期提取：识别重要日期与具体时间', () => {
  const archives = extractArchives('下周五是我妈的生日，8月20日还有一场面试。', '');
  const dates = archives.filter((a) => a.type === '日期');
  assert.ok(dates.length >= 2);
  const birthday = dates.find((a) => a.insight.includes('生日'));
  assert.ok(birthday);
  assert.equal(birthday.confidence, '高');
  assert.ok(birthday.insight.includes('下周五'));
  const interview = dates.find((a) => a.insight.includes('面试'));
  assert.ok(interview);
  assert.equal(interview.confidence, '高');
  assert.ok(interview.insight.includes('8月20日'));
});

test('身份提取：我是/我叫/我今年/我在', () => {
  const archives = extractArchives('我叫小鹿，我今年25岁，我在上海工作。', '');
  const ids = archives.filter((a) => a.type === '身份');
  assert.ok(ids.length >= 2, '应提取多条身份信息');
  const name = ids.find((a) => a.insight.includes('小鹿'));
  assert.ok(name);
  assert.equal(name.confidence, '高');
  assert.ok(name.dialog.includes('我叫小鹿'));
  assert.ok(ids.some((a) => a.insight.includes('25')));
  assert.ok(ids.some((a) => a.insight.includes('上海')));
});

test('模式提取：跨 ≥2 轮/天才判定，单条消息不产出（假模式消除）', () => {
  const single = extractArchives('我每天都要喝一杯咖啡，周末也常去咖啡馆坐坐，咖啡对我来说就是必需品。', '');
  assert.ok(!single.some((a) => a.type === '模式'), '单条消息内多次提及不判定为模式（BC-4 假模式消除）');
  const cross = detectCrossTurnPatterns([
    '我每天都要喝一杯咖啡，周末也常去咖啡馆坐坐，咖啡对我来说就是必需品。',
    '今天又去喝了一杯咖啡，还是喜欢拿铁。',
  ]);
  const pattern = cross.find((a) => a.type === '模式' && a.insight.includes('咖啡'));
  assert.ok(pattern, '跨轮多次提及应识别「咖啡」模式');
  assert.equal(pattern.confidence, '中');
  assert.ok(pattern.tags.includes('#咖啡'));
});
test('conflict：同主题相反偏好标注冲突', () => {
  const archives = extractArchives('我不喜欢咖啡，但每天早上都要喝一杯咖啡提神。', '');
  const conflicted = archives.find((a) => a.type === '偏好' && a.conflict);
  assert.ok(conflicted, '应标注偏好冲突');
});

test('情绪基调映射：焦虑 > 低落 > 兴奋 > 轻松 > 平静', () => {
  assert.equal(buildSessionSummary('2026-08-08', '明天要面试，好紧张。', '', []).mood, '焦虑');
  assert.equal(buildSessionSummary('2026-08-08', '今天好累，心里有点烦。', '', []).mood, '低落');
  assert.equal(buildSessionSummary('2026-08-08', '今天太开心了！', '', []).mood, '兴奋');
  assert.equal(buildSessionSummary('2026-08-08', '今天泡了温泉，很放松。', '', []).mood, '轻松');
  assert.equal(buildSessionSummary('2026-08-08', '嗯，随便聊聊。', '', []).mood, '平静');
});

test('topics：提取 2-5 个核心话题', () => {
  const summary = buildSessionSummary('2026-08-08', '今天喝了一杯咖啡，晚上还去看了电影，周末打算去健身。', '', []);
  assert.ok(summary.topics.length >= 2 && summary.topics.length <= 5);
  assert.ok(summary.topics.includes('咖啡'));
  assert.ok(summary.topics.includes('电影'));
});

test('newMemories：格式为「类型 | 内容 | 置信度」', () => {
  const archives = extractArchives('我不喜欢咖啡。', '');
  const summary = buildSessionSummary('2026-08-08', '我不喜欢咖啡。', '', archives);
  assert.ok(summary.newMemories.length >= 1);
  for (const line of summary.newMemories) {
    assert.match(line, /^[^|]+ \| .+ \| (高|中|低)$/);
  }
  assert.ok(summary.newMemories[0].includes('| 用户不喜欢「咖啡」'));
});

test('followUps：识别未完成事项', () => {
  const summary = buildSessionSummary('2026-08-08', '下次一起去看电影吧，我打算周末去爬山。', '', []);
  assert.ok(summary.followUps.some((f) => f.includes('电影')));
  assert.ok(summary.followUps.some((f) => f.includes('爬山')));
});

test('空输入不产生垃圾条目', () => {
  assert.deepEqual(extractArchives('', ''), []);
  assert.deepEqual(extractArchives('   \n  ', ''), []);
  assert.deepEqual(extractArchives('   ', '你好呀'), []);
  const summary = buildSessionSummary('2026-08-08', '', '', []);
  assert.deepEqual(summary.newMemories, []);
  assert.equal(summary.mood, '平静');
  assert.deepEqual(summary.followUps, []);
  assert.ok(Array.isArray(summary.topics));
});

// ===== 集成回归：技术主管验收补测（2026-08-09） =====

test('偏好提取：无「我」前缀的「还是更喜欢」也能提取', () => {
  const entries = extractArchives('今天试了燕麦拿铁，还是更喜欢传统拿铁。', '');
  const pref = entries.find((e) => e.type === '偏好' && e.insight.includes('传统拿铁'));
  assert.ok(pref, '应提取「更喜欢传统拿铁」偏好');
  assert.equal(pref!.confidence, '高');
});

test('偏好提取：负向偏好「不太喜欢」回溯取对象', () => {
  const entries = extractArchives('今天试了燕麦拿铁，不太喜欢。', '');
  const neg = entries.find((e) => e.type === '偏好' && e.insight.includes('不喜欢'));
  assert.ok(neg, '应提取负向偏好');
  assert.ok(neg!.insight.includes('燕麦拿铁'), '负向偏好应回溯到对象「燕麦拿铁」，实际：' + neg!.insight);
});

test('经历提取：否定感受不被误判为正向', () => {
  const entries = extractArchives('今天去咖啡馆试了燕麦拿铁，不太喜欢，还是更喜欢传统拿铁。', '');
  const exp = entries.find((e) => e.type === '经历');
  assert.ok(exp, '应提取经历条目');
  assert.match(exp!.insight, /不喜欢/, '感受应为「不喜欢」，实际：' + exp!.insight);
});