/**
 * 检索 golden 评测集（第 7 期批次三 T11 · D-4 红侧先行；KS-7.27「先基线后断言」）
 *
 * 防形式化三件套：
 * - tests/fixtures/retrieval-golden.json：12 条真实中文问题 → 期望命中关键词
 *   （覆盖：罕见词 vs 常见词干扰、时间近因、置信度分层、标签命中、多主题、农历日期、近期会话）；
 * - tests/fixtures/retrieval-baseline.json：临时 runner（retrieval-baseline-runner.mjs，不入 test glob）
 *   对**现状** retrieveRelevant 实跑记录的命中率与逐条结果（generatedAt 可查，禁止手填）；
 * - 本测试：把 golden 语料写成隔离 history/ 五维文件（isolateHome）→ 跑**新检索入口**
 *   searchScored（src/retrieval.ts，统一打分）→ 断言逐条全命中 + 总命中率/命中数 ≥ 基线。
 *
 * 红侧现状：searchScored 为 not-implemented 壳 → 本套件红（红之前基线已实跑记录：12/12=100%）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { searchScored } from '../src/retrieval';
import { isolateHome } from './helpers';

const iso = isolateHome();
test.after(() => iso.restore());

/** fixture 目录：源码树 tests/fixtures（编译产物在 dist-test/tests，经 ../../ 回到项目根） */
const fixturesDir = path.resolve(__dirname, '..', '..', 'tests', 'fixtures');

interface GoldenFile {
  path: string;
  content: string[] | string;
}
interface GoldenQuestion {
  id: string;
  category: string;
  question: string;
  expectKeywords: string[];
}
interface GoldenFixture {
  version: number;
  historyFiles: GoldenFile[];
  questions: GoldenQuestion[];
}
interface BaselineItem {
  id: string;
  hit: boolean;
  found: string[];
  missing: string[];
}
interface BaselineFixture {
  generatedAt: string;
  engine: string;
  totalQuestions: number;
  hitCount: number;
  hitRate: number;
  perItem: BaselineItem[];
}

const golden = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'retrieval-golden.json'), 'utf8')) as GoldenFixture;

test('检索 golden：新 scored 检索 12 条全命中，命中率/命中数 ≥ 现状基线（先基线后断言）', () => {
  // 基线完整性守卫：必须存在且是实跑产物（generatedAt + 逐条结果齐全），防手填防形式化
  const baselinePath = path.join(fixturesDir, 'retrieval-baseline.json');
  assert.ok(fs.existsSync(baselinePath), 'retrieval-baseline.json 必须存在（先跑 retrieval-baseline-runner.mjs 实录基线）');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as BaselineFixture;
  assert.ok(typeof baseline.generatedAt === 'string' && !Number.isNaN(Date.parse(baseline.generatedAt)), '基线应带 generatedAt（实跑时间戳）');
  assert.equal(baseline.totalQuestions, golden.questions.length, '基线题量应与 golden 一致');
  assert.equal(baseline.perItem.length, golden.questions.length, '基线应含逐条结果');

  // 构造隔离语料：golden historyFiles → 临时 history/ 五维文件（isolateHome）
  const historyDir = path.join(iso.home, 'history');
  for (const f of golden.historyFiles) {
    const target = path.join(historyDir, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Array.isArray(f.content) ? f.content.join('\n') : f.content, 'utf8');
  }

  // 跑新检索入口（统一打分），逐条断言期望关键词全部出现在命中文本中
  const failures: string[] = [];
  let hitCount = 0;
  for (const q of golden.questions) {
    const hits = searchScored(q.question, historyDir);
    const text = hits.map((h) => `${h.source} ${h.text}`).join('\n');
    const missing = q.expectKeywords.filter((k) => !text.includes(k));
    if (missing.length === 0) hitCount += 1;
    else failures.push(`${q.id}[${q.category}]「${q.question}」缺失关键词：${missing.join('、')}`);
  }

  const total = golden.questions.length;
  assert.equal(
    failures.length,
    0,
    `golden 未全命中（${hitCount}/${total}）：\n${failures.join('\n')}`,
  );
  assert.ok(
    hitCount >= baseline.hitCount,
    `新检索命中数 ${hitCount} 应 ≥ 基线 ${baseline.hitCount}（基线 generatedAt=${baseline.generatedAt}）`,
  );
  assert.ok(
    hitCount / total >= baseline.hitRate,
    `新检索命中率 ${((hitCount / total) * 100).toFixed(1)}% 应 ≥ 基线 ${(baseline.hitRate * 100).toFixed(1)}%`,
  );
});
