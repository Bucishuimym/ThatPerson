/**
 * 临时 runner（不入 test glob：node --test 只匹配 dist-test/tests/*.test.js；本文件为 tests/fixtures/ 下的 .mjs）
 *
 * 用途（批次三 T11 · 防形式化）：对「现状」retrieveRelevant（两级瀑布：标签先到先得 + 词法包含）
 * 实跑 tests/fixtures/retrieval-golden.json 的 12 条评测题，把命中率与逐条结果落盘
 * tests/fixtures/retrieval-baseline.json —— 该基线随批次三三件套存档，golden 测试断言新 scored 检索命中率 >= 基线。
 *
 * 运行：node tests/fixtures/retrieval-baseline-runner.mjs           （先 npm run build 保证 dist 与 src 同步）
 *       node tests/fixtures/retrieval-baseline-runner.mjs --no-write（Q-1 备忘收口：只实跑对比归档基线，绝不覆写）
 * 原则：真实实跑现状代码记录数字，禁止手填。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const noWrite = process.argv.slice(2).includes('--no-write');

const require = createRequire(import.meta.url);
const { retrieveRelevant } = require('../../dist/src/chat.js');
const { createMemoryStore } = require('../../dist/src/memory/store.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenPath = path.join(here, 'retrieval-golden.json');
const baselinePath = path.join(here, 'retrieval-baseline.json');

const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));

// —— 构造隔离语料：把 golden 语料写成临时 history/ 五维文件，再经 createMemoryStore().load() 装载 ——
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-golden-runner-'));
const historyDir = path.join(root, 'history');
for (const f of golden.historyFiles) {
  const target = path.join(historyDir, f.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = Array.isArray(f.content) ? f.content.join('\n') : f.content;
  fs.writeFileSync(target, content, 'utf8');
}

const memories = await createMemoryStore(root).load(); // 与 golden 测试同口径装载五维语料

let hitCount = 0;
const perItem = [];
for (const q of golden.questions) {
  const result = retrieveRelevant(q.question, memories, []);
  const found = q.expectKeywords.filter((k) => result.includes(k));
  const missing = q.expectKeywords.filter((k) => !result.includes(k));
  const hit = missing.length === 0;
  if (hit) hitCount += 1;
  perItem.push({
    id: q.id,
    category: q.category,
    question: q.question,
    expected: q.expectKeywords,
    found,
    missing,
    hit,
  });
}

const total = golden.questions.length;
const hitRate = Number((hitCount / total).toFixed(4));
const baseline = {
  generatedAt: new Date().toISOString(),
  engine: 'retrieveRelevant（现状两级瀑布：标签先到先得 + 词法子串包含）@ dist/src/chat.js',
  source: 'tests/fixtures/retrieval-golden.json',
  totalQuestions: total,
  hitCount,
  hitRate,
  criteria: '单题 hit = expectKeywords 全部出现在检索返回文本中（含命中行裁剪后的文本）',
  perItem,
};

let exitCode = 0;
if (noWrite) {
  // Q-1 备忘收口：重跑不得覆写归档基线（基线随三件套存档）；--no-write 只实跑对比现行结果
  if (fs.existsSync(baselinePath)) {
    const archived = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const ok = hitRate >= archived.hitRate;
    console.log(
      `[retrieval-baseline] --no-write：归档基线未改动（hitRate 基线=${archived.hitRate} → 本次=${hitRate}，${ok ? '不低于基线' : '低于基线'})`,
    );
    exitCode = ok ? 0 : 1;
  } else {
    console.warn(`[retrieval-baseline] --no-write：归档基线不存在，请先不带 --no-write 跑一次建立基线`);
    exitCode = 1;
  }
} else {
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  console.log(`[retrieval-baseline] 已写入 ${baselinePath}`);
}
fs.rmSync(root, { recursive: true, force: true });

console.log(`[retrieval-baseline] 命中 ${hitCount}/${total}，命中率 ${(hitRate * 100).toFixed(1)}%`);
for (const item of perItem) {
  console.log(
    `  ${item.hit ? 'PASS' : 'MISS'} ${item.id} ${item.category}：found=[${item.found.join(',')}] missing=[${item.missing.join(',')}]`,
  );
}
if (!noWrite) console.log(`[retrieval-baseline] 已写入 ${baselinePath}`);
process.exitCode = exitCode;
