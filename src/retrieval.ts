/**
 * 检索增强模块（第 7 期批次三 T11 · KS-7.27 裁剪版）
 *
 * 职责（KS-7.27 裁剪版）：统一打分检索 + 持久化倒排索引 + 截断蒸馏装配。
 * - 统一打分（标签与词法**同公式竞争**，废除先到先得瀑布）：
 *     score = Σ_terms[idf(t) × tfSat(t)] × decay × conf
 *   其中 tfSat = tf/(tf+1.2)；idf = ln(1 + N/df)（df 按语料段落统计，罕见词高分）；
 *   标签命中作为该词的加成项（命中 #标签 的段落对该词 ×1.5）；decay = exp(-days/90)
 *   （LOW_CONFIDENCE_TTL_DAYS 同量级）；置信度权重 高 1.0 / 中 0.7 / 低 0.4。
 * - 语料化：history/ 五维 .md → 段落（对齐 chat.ts corpusParagraphs 现有分段语义：空行切段、
 *   长段按句边界折 ≤240 字符），条目元数据 = {source, startLine, endLine, text, entryDate
 *   （所在 `## YYYY-MM-DD` 节头，无则文件 mtime 日期）, confidence（`- **置信度**：高|中|低`，缺省中）,
 *   tags（行内 #标签）}；去重对齐现状：同一 source+段落只留最高分。
 * - 持久化倒排索引：`<historyDir>/index/retrieval-index.json`（段落 + 文件 mtime/size 指纹；
 *   terms 倒排省略，载入时内存构建）；查询时惰性增量（指纹变化文件重索引、删除即剔除；
 *   零写入路径改动）；rebuildIndex() 全量重建后同查询结果一致（R-4）。
 * - 截断蒸馏：预算外长命中 → __setDistillImpl 注入的蒸馏实现（缺省 = 无 Key/无桩 → 直截断）；
 *   净省判据：estimateTokens(被替换原文) - estimateTokens(摘要) ≤ promptTokens+completionTokens
 *   （净亏）→ 回退直截断；蒸馏产物标注「（摘要）」；每次蒸馏成功记台账 kind='distill'。
 *
 * 红线：纯 node: 原生零依赖；不新增网络面（蒸馏实现经注入点接入，本模块自身零网络调用）；
 * SEC 边界不后退（<memory> + 仅为参考不变，由 chat.ts buildSystemPrompt 包裹）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { envInt } from './tools/guards';
import type { Confidence } from './memory/types';

/** 检索命中层字符预算（名实一致口径校准）：clip 字符断言的真名 */
export const RETRIEVE_LAYER_CHAR_LIMIT = 1200;

/**
 * @deprecated 兼容别名：与 RETRIEVE_LAYER_CHAR_LIMIT 同值同义（现状 clip 字符口径）。
 * 仅存量引用过渡期可用，新代码一律用 RETRIEVE_LAYER_CHAR_LIMIT。
 */
export const RETRIEVE_LAYER_BUDGET = RETRIEVE_LAYER_CHAR_LIMIT;

/** 检索命中 Top-K 缺省值（同源 chat.ts RETRIEVE_TOP_K：THATPERSON_RETRIEVE_TOP_K 可调，默认 12） */
const DEFAULT_TOP_K = envInt('THATPERSON_RETRIEVE_TOP_K', 12);

/** 段落字符上限（同源 chat.ts corpusParagraphs：长段按句边界折 ≤240 字符） */
const PARAGRAPH_CHAR_LIMIT = 240;

/** 单条命中行的行级预算（同源 chat.ts retrieveRelevant 现状 clip(hit, 120) 口径） */
const HIT_LINE_CHAR_LIMIT = 120;

/** tf 饱和常数（BM25 式 tfSat = tf/(tf+k)） */
const TF_SAT_K = 1.2;
/** 标签命中加成（命中 #标签 的段落对该词 ×1.5） */
const TAG_BOOST = 1.5;
/** 时间衰减周期（天）：decay = exp(-days/90)，LOW_CONFIDENCE_TTL_DAYS 同量级 */
const DECAY_TTL_DAYS = 90;
/** 置信度权重（高 1.0 / 中 0.7 / 低 0.4；缺省中） */
const CONFIDENCE_WEIGHT: Record<Confidence, number> = { 高: 1.0, 中: 0.7, 低: 0.4 };

/** 蒸馏产物行前缀（SEC：蒸馏产物标「（摘要）」，原文可 read_file） */
const DISTILL_MARK = '（摘要）';

/** 一条带分数的检索命中（新检索入口的返回单元） */
export interface ScoredHit {
  /** 命中来源（对齐现状语料口径：profile/preferences.md、insights/patterns.md、experiences/journal.md、timeline/important_dates.md、session_logs） */
  source: string;
  /** 命中文本（段落/条目单元原文，未注入级截断） */
  text: string;
  /** 统一打分：Σ[idf × tfSat × 标签加成] × 时间衰减 × 置信度权重 */
  score: number;
  /** 命中段落在源文件内的起始行（1-based） */
  startLine?: number;
  /** 命中段落在源文件内的结束行（1-based） */
  endLine?: number;
  /** 条目日期（`## YYYY-MM-DD` 节头；无则文件 mtime 日期；内存语料无则当天） */
  entryDate?: string | null;
  /** 条目置信度（缺省中） */
  confidence?: Confidence;
  /** 行内 #标签 */
  tags?: string[];
}

/** 内存语料项（chat.ts retrieveRelevant 的 LoadedMemories 内存态口径；免落盘直评） */
export interface CorpusItem {
  /** 语料来源名（如 profile/preferences.md、experiences/journal.md、session_logs） */
  source: string;
  /** 语料原文（多行文本，按段落切分） */
  text: string;
}

/** 蒸馏实现注入签名：输入原文与预算，返回摘要 + 本次蒸馏开销（记账 kind='distill' 用） */
export type DistillImpl = (
  text: string,
  ctx: { budgetChars: number },
) => Promise<{ summary: string; promptTokens: number; completionTokens: number }>;

/** assembleInjection 返回：装配后的检索命中注入串（≤ 预算）与蒸馏统计 */
export interface InjectionResult {
  /** 最终注入文本（超预算部分已蒸馏/截断；含「（摘要）」标注或直截断省略号） */
  injection: string;
  /** 实际走了蒸馏的命中条数 */
  distilledCount: number;
  /** 净省判据触发：蒸馏开销 >= 注入节省 → 回退直截断 */
  fellBack: boolean;
}

/** 检索查询选项（opts 向后兼容扩展：corpus 提供时对内存语料直评、忽略 historyDir） */
export interface SearchOptions {
  /** 返回条数上限（缺省 RETRIEVE_TOP_K=12，同源 chat.ts） */
  topK?: number;
  /** 内存语料直评（chat.ts retrieveRelevant 的 LoadedMemories 路径专用；不落盘不建索引） */
  corpus?: readonly CorpusItem[];
}

// ===== 停用词 / 话题联想 / 关键词提取（同源复制自 chat.ts，注释同源；不改 chat.ts 导出面） =====

/** 停用词：泛词不参与检索（3b；同源 chat.ts STOP_WORDS） */
const STOP_WORDS = new Set([
  '喜欢', '今天', '昨天', '明天', '觉得', '真的', '比较', '有点', '有些', '什么', '怎么', '为什么',
  '一个', '这个', '那个', '我们', '你们', '他们', '可以', '没有', '不是', '就是', '还是', '一下',
  '感觉', '自己', '知道', '时候', '然后', '现在', '最近', '应该', '可能', '大概', '所以', '但是',
  '如果', '因为', '而且', '还有', '已经', '一直', '起来', '过去', '不过', '其实', '每次', '每次',
  '是不是', '好不好', '怎么样', '一起', '再', '也', '都', '很', '太', '挺', '蛮',
]);

/** 话题联想表（3b）：关键词 -> 联想词，扩大召回（同源 chat.ts TOPIC_ASSOCIATIONS） */
const TOPIC_ASSOCIATIONS: Readonly<Record<string, readonly string[]>> = {
  咖啡: ['咖啡', '拿铁', '美式', '燕麦拿铁', '手冲', '咖啡店', '咖啡馆'],
  拿铁: ['咖啡', '拿铁', '燕麦拿铁'],
  篮球: ['篮球', '打球', '球赛', '运动', '球场'],
  运动: ['运动', '健身', '跑步', '篮球', '瑜伽', '游泳', '爬山', '骑行', '锻炼'],
  健身: ['健身', '运动', '锻炼', '瑜伽', '撸铁'],
  猫: ['猫', '宠物', '猫咪'],
  狗: ['狗', '宠物', '狗狗'],
  电影: ['电影', '观影', '新片'],
  阅读: ['阅读', '读书', '看书', '书'],
  旅行: ['旅行', '旅游', '出行'],
  音乐: ['音乐', '唱歌', '听歌', '歌'],
  游戏: ['游戏', '打游戏', '电竞'],
  工作: ['工作', '上班', '加班', '同事', '公司', '项目'],
  学习: ['学习', '上课', '考试', '论文', '作业'],
  美食: ['美食', '吃饭', '做饭', '餐厅', '好吃'],
  宠物: ['宠物', '猫', '狗', '猫咪', '狗狗'],
};

/** 清洗关键词：过滤停用词与过短词（同源 chat.ts cleanKeywords） */
function cleanKeywords(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    const t = w.trim();
    if (t.length < 2 || STOP_WORDS.has(t)) continue;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** 提取关键词：中文字段（2-8 字）+ 二元滑窗 + 话题联想扩展（3b；同源 chat.ts extractKeywords） */
function extractKeywords(userText: string): string[] {
  const spans = userText.match(/[\u4e00-\u9fa5]{2,8}/g) ?? [];
  const chars = userText.match(/[\u4e00-\u9fa5]/g) ?? [];
  const bigrams: string[] = [];
  for (let i = 0; i < chars.length - 1; i += 1) bigrams.push(chars[i] + chars[i + 1]);
  let keywords = cleanKeywords([...spans, ...bigrams]);
  // 话题联想扩展
  const extended: string[] = [...keywords];
  for (const kw of keywords) {
    for (const [topic, related] of Object.entries(TOPIC_ASSOCIATIONS)) {
      if (kw.includes(topic) || topic.includes(kw)) {
        extended.push(...related);
      }
    }
  }
  keywords = cleanKeywords(extended);
  return keywords.sort((a, b) => b.length - a.length).slice(0, 20);
}

/** 粗略 token 估算：中文≈1 token，其他字符≈0.35（同源 chat.ts estimateTokens，蒸馏净省判据用） */
function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk + other * 0.35);
}

/** 截断到指定字符数（保留语义完整性；同源 chat.ts clip） */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

/** 本地时区 YYYY-MM-DD（同源 chat.ts today） */
function localDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ===== 语料段落化（含条目元数据） =====

/** 内部段落单元（打分与索引共用的最小语料粒度） */
interface Paragraph {
  source: string;
  startLine: number;
  endLine: number;
  text: string;
  tags: string[];
  entryDate: string | null;
  confidence: Confidence;
}

/** 解析条目置信度：`- **置信度**：高|中|低`，缺省中 */
function parseConfidence(text: string): Confidence {
  const m = text.match(/\*\*置信度\*\*\s*[:：]\s*([高中低])/);
  return (m ? (m[1] as Confidence) : '中');
}

/** 解析行内 #标签（剔除 markdown 标题产生的纯 # 串） */
function parseTags(text: string): string[] {
  return (text.match(/#[^\s`]+/g) ?? []).filter((t) => !/^#+$/.test(t));
}

/** 长段按句边界折成 ≤240 字符片段（同源 chat.ts corpusParagraphs 折叠逻辑） */
function foldLongParagraph(block: string): string[] {
  const pieces = block.split(/(?<=[。！？!?；;])\s*/).filter(Boolean);
  const out: string[] = [];
  let buf = '';
  for (const piece of pieces) {
    if (buf && (buf + piece).length > PARAGRAPH_CHAR_LIMIT) {
      out.push(buf);
      buf = piece;
    } else {
      buf += piece;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 语料段落化（空行切段 + 列表条目行独立成单元；超长单元按句边界折 ≤240 字符，
 * 折叠语义同源 chat.ts corpusParagraphs）。
 * - 列表行（- / * 开头）逐行独立成检索单元：D-4 R-2a/R-2b 契约要求同一空行块内相邻条目
 *   可独立命中并按分竞争（现状 appendArchive 语料的条目行间无空行）；
 * - 非列表连续行合并为一个散文单元（保留正文段落语义）；
 * - 条目元数据：`- **置信度**：高|中|低` 与 `- **关联标签**：#x #y` 元数据行按归档格式
 *   位于条目尾部，块结束时回溯应用到同块内容单元；行内 #标签 归所属单元。
 */
function parseParagraphs(text: string, source: string, fallbackDate: string | null): Paragraph[] {
  const out: Paragraph[] = [];
  const lines = (text ?? '').split('\n');
  let currentDate: string | null = null;
  let block: Paragraph[] = [];
  let prose: Array<{ no: number; text: string }> = [];
  const isBullet = (line: string): boolean => /^\s*[-*•]\s/.test(line);
  const isMetaLine = (t: string): boolean => /\*\*置信度\*\*/.test(t) || /关联标签/.test(t);

  const flushProse = (): void => {
    if (prose.length === 0) return;
    const joined = prose.map((l) => l.text).join('\n').trim();
    if (joined) {
      const meta = {
        source,
        startLine: prose[0].no,
        endLine: prose[prose.length - 1].no,
        entryDate: currentDate ?? fallbackDate,
      };
      for (const piece of joined.length <= PARAGRAPH_CHAR_LIMIT ? [joined] : foldLongParagraph(joined)) {
        block.push({ ...meta, text: piece, tags: parseTags(piece), confidence: parseConfidence(piece) });
      }
    }
    prose = [];
  };

  const flushBlock = (): void => {
    flushProse();
    if (block.length === 0) return;
    // 元数据行回溯（归档条目：置信度/关联标签位于条目尾部，描述同块前置内容单元）
    let conf: Confidence | null = null;
    let tags: string[] | null = null;
    for (const u of block) {
      const cm = u.text.match(/\*\*置信度\*\*\s*[:：]\s*([高中低])/);
      if (cm) conf = cm[1] as Confidence;
      const tm = u.text.match(/关联标签\*{0,2}\s*[：:]\s*(.+)/);
      if (tm) {
        const parsed = parseTags(tm[1]);
        if (parsed.length > 0) tags = parsed;
      }
    }
    if (conf || tags) {
      for (const u of block) {
        if (isMetaLine(u.text)) continue;
        if (conf) u.confidence = conf;
        if (tags) u.tags = [...new Set([...u.tags, ...tags])];
      }
    }
    out.push(...block);
    block = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const dm = raw.match(/^\s*#{1,6}\s*(\d{4}-\d{2}-\d{2})\b/);
    if (dm) currentDate = dm[1];
    if (!raw.trim()) {
      flushBlock();
      continue;
    }
    if (isBullet(raw)) {
      flushProse();
      const lineText = raw.trim();
      const meta = { source, startLine: i + 1, endLine: i + 1, entryDate: currentDate ?? fallbackDate };
      for (const piece of lineText.length <= PARAGRAPH_CHAR_LIMIT ? [lineText] : foldLongParagraph(lineText)) {
        block.push({ ...meta, text: piece, tags: parseTags(piece), confidence: parseConfidence(piece) });
      }
    } else {
      prose.push({ no: i + 1, text: raw });
    }
  }
  flushBlock();
  return out;
}

/** 内存语料 → 段落（无 mtime，entryDate 回退当天 → 衰减≈1，对齐现状无衰减行为） */
function corpusToParagraphs(corpus: readonly CorpusItem[]): Paragraph[] {
  const todayStr = localDateStr(new Date());
  const out: Paragraph[] = [];
  for (const item of corpus) {
    if (!item || typeof item.text !== 'string' || !item.text) continue;
    out.push(...parseParagraphs(item.text, item.source ?? '', todayStr));
  }
  return out;
}

// ===== 统一打分 =====

/** 子串非重叠出现次数（tf） */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** 标签命中判定：段落 #标签 与查询词互含（#咖啡 ↔ 咖啡 / #饮食偏好 ↔ 饮食） */
function hasTagBoost(tags: string[] | undefined, term: string): boolean {
  if (!tags || tags.length === 0) return false;
  for (const tag of tags) {
    const label = tag.replace(/^#+/, '');
    if (!label) continue;
    if (label === term || label.includes(term) || term.includes(label)) return true;
  }
  return false;
}

/** 时间衰减：exp(-days/90)；无日期按 1（不衰减） */
function decayFactor(entryDate: string | null | undefined, now: number): number {
  if (!entryDate) return 1;
  const [y, m, d] = entryDate.split('-').map(Number);
  if (!y || !m || !d) return 1;
  const days = Math.max(0, (now - new Date(y, m - 1, d).getTime()) / 86_400_000);
  return Math.exp(-days / DECAY_TTL_DAYS);
}

/** 命中排序：score 降序 → entryDate 新者优先 → source/startLine 稳定序（重建一致、结果确定性） */
function compareHits(a: ScoredHit, b: ScoredHit): number {
  if (b.score !== a.score) return b.score - a.score;
  const ad = a.entryDate ?? '';
  const bd = b.entryDate ?? '';
  if (ad !== bd) return ad > bd ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  const al = a.startLine ?? 0;
  const bl = b.startLine ?? 0;
  if (al !== bl) return al - bl;
  return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
}

/**
 * 统一打分核心：score = Σ_terms[idf(t) × tfSat(t) × 标签加成] × decay × conf。
 * df 按语料段落统计（罕见词 idf 高分）；同一 source+段落只留最高分（去重对齐现状）。
 */
function scoreParagraphs(query: string, paragraphs: Paragraph[], topK: number): ScoredHit[] {
  const terms = extractKeywords(query);
  if (terms.length === 0 || paragraphs.length === 0 || topK <= 0) return [];
  const n = paragraphs.length;
  const now = Date.now();
  const dfCache = new Map<string, number>();
  const dfOf = (term: string): number => {
    let df = dfCache.get(term);
    if (df === undefined) {
      df = 0;
      for (const p of paragraphs) {
        if (p.text.includes(term)) df += 1;
      }
      dfCache.set(term, df);
    }
    return df;
  };
  const dedup = new Map<string, ScoredHit>();
  for (const p of paragraphs) {
    let sum = 0;
    for (const term of terms) {
      const tf = countOccurrences(p.text, term);
      if (tf <= 0) continue;
      const df = dfOf(term);
      if (df <= 0) continue;
      let contrib = Math.log(1 + n / df) * (tf / (tf + TF_SAT_K));
      if (hasTagBoost(p.tags, term)) contrib *= TAG_BOOST;
      sum += contrib;
    }
    if (sum <= 0) continue;
    const score = sum * decayFactor(p.entryDate, now) * (CONFIDENCE_WEIGHT[p.confidence] ?? CONFIDENCE_WEIGHT['中']);
    const hit: ScoredHit = {
      source: p.source,
      text: p.text,
      score,
      startLine: p.startLine,
      endLine: p.endLine,
      entryDate: p.entryDate,
      confidence: p.confidence,
      tags: p.tags,
    };
    // 去重对齐现状：同一 source+段落只留最高分
    const key = `${p.source}\u0000${p.text}`;
    const prev = dedup.get(key);
    if (!prev || hit.score > prev.score) dedup.set(key, hit);
  }
  return [...dedup.values()].sort(compareHits).slice(0, topK);
}

// ===== 持久化倒排索引（history/index/retrieval-index.json） =====

/** 索引格式版本（结构不兼容时全量重建） */
const INDEX_VERSION = 1;

/** 索引内单条段落（落盘结构：段落 + 指纹即可，terms 倒排载入时内存构建） */
interface IndexedParagraph {
  startLine: number;
  endLine: number;
  text: string;
  tags: string[];
  entryDate: string | null;
  confidence: Confidence;
}

/** 索引内单文件：mtime/size 指纹 + 段落集 */
interface IndexedFile {
  mtimeMs: number;
  size: number;
  paragraphs: IndexedParagraph[];
}

/** 落盘索引结构：{version, files: {[相对路径]: {mtimeMs,size,paragraphs}} */
interface RetrievalIndex {
  version: number;
  files: Record<string, IndexedFile>;
}

/** 进程内索引缓存（key = resolve 后的 historyDir；查询间复用，避免重复读盘） */
const indexCache = new Map<string, RetrievalIndex>();

/** 索引文件路径：<historyDir>/index/retrieval-index.json（history/index/ 为唯一新落盘目录） */
function indexPathOf(historyDir: string): string {
  return path.join(historyDir, 'index', 'retrieval-index.json');
}

/** 递归列出 history 下全部 .md（跳过 index/ 索引目录；结果排序保证确定性） */
function listMarkdownFiles(historyDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'index') continue; // 索引目录不入语料（可重建非唯一事实）
        walk(full);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(historyDir);
  return out.sort();
}

/** 相对路径统一正斜杠（source 口径稳定，跨平台一致） */
function toRelPath(historyDir: string, absFile: string): string {
  return path.relative(historyDir, absFile).replace(/\\/g, '/');
}

/** 索引单个文件 → 段落集（entryDate 无节头时回退文件 mtime 日期） */
function indexFileParagraphs(absFile: string, relPath: string, mtimeMs: number): IndexedParagraph[] {
  let content = '';
  try {
    content = fs.readFileSync(absFile, 'utf8');
  } catch {
    return [];
  }
  const fallbackDate = localDateStr(new Date(mtimeMs));
  return parseParagraphs(content, relPath, fallbackDate).map((p) => ({
    startLine: p.startLine,
    endLine: p.endLine,
    text: p.text,
    tags: p.tags,
    entryDate: p.entryDate,
    confidence: p.confidence,
  }));
}

/** 读落盘索引（缺失/损坏/版本不符 → 空索引，等价全量重建） */
function loadIndexFile(indexPath: string): RetrievalIndex {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as RetrievalIndex;
    if (
      parsed &&
      parsed.version === INDEX_VERSION &&
      parsed.files &&
      typeof parsed.files === 'object'
    ) {
      return parsed;
    }
  } catch {
    // 缺失/损坏 → 空索引（惰性全量重建）
  }
  return { version: INDEX_VERSION, files: {} };
}

/** 落盘索引（best-effort：失败不阻塞查询，内存索引仍可用；索引可重建非唯一事实） */
function persistIndex(indexPath: string, index: RetrievalIndex): void {
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, `${JSON.stringify(index)}\n`, 'utf8');
  } catch {
    // 落盘失败不影响本次查询结果
  }
}

/** 展开索引为打分段落序列（文件名排序 + 段落原序，保证确定性） */
function flattenIndex(index: RetrievalIndex): Paragraph[] {
  const out: Paragraph[] = [];
  for (const rel of Object.keys(index.files).sort()) {
    const file = index.files[rel];
    if (!file || !Array.isArray(file.paragraphs)) continue;
    for (const p of file.paragraphs) {
      if (!p || typeof p.text !== 'string' || !p.text) continue;
      out.push({ source: rel, ...p });
    }
  }
  return out;
}

/**
 * 查询前惰性增量校准：按 mtime/size 指纹重索引变化文件、剔除已删除文件（零写入路径改动）。
 * 指纹有变化时才重写索引文件；historyDir 不存在时按空语料处理（不创建目录）。
 */
export function ensureIndexFresh(historyDir: string): void {
  const dir = path.resolve(historyDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    indexCache.set(dir, { version: INDEX_VERSION, files: {} });
    return;
  }
  const indexPath = indexPathOf(dir);
  const index = indexCache.get(dir) ?? loadIndexFile(indexPath);
  // 现盘 .md 指纹
  const diskFiles = new Map<string, { mtimeMs: number; size: number }>();
  for (const abs of listMarkdownFiles(dir)) {
    try {
      const st = fs.statSync(abs);
      diskFiles.set(toRelPath(dir, abs), { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // 不可 stat 的文件跳过
    }
  }
  let changed = false;
  // 消失文件剔除
  for (const rel of Object.keys(index.files)) {
    if (!diskFiles.has(rel)) {
      delete index.files[rel];
      changed = true;
    }
  }
  // 新增 / 指纹变化文件重索引
  for (const [rel, fp] of diskFiles) {
    const cur = index.files[rel];
    if (!cur || cur.mtimeMs !== fp.mtimeMs || cur.size !== fp.size) {
      index.files[rel] = {
        mtimeMs: fp.mtimeMs,
        size: fp.size,
        paragraphs: indexFileParagraphs(path.join(dir, rel), rel, fp.mtimeMs),
      };
      changed = true;
    }
  }
  if (changed) persistIndex(indexPath, index);
  indexCache.set(dir, index);
}

/** 全量重建 `<historyDir>/index/retrieval-index.json`；删索引后重建，原查询结果一致（R-4） */
export function rebuildIndex(historyDir: string): void {
  const dir = path.resolve(historyDir);
  try {
    fs.rmSync(indexPathOf(dir), { force: true });
  } catch {
    // 删失败也无碍：缓存失效后 ensureIndexFresh 会全量重索引
  }
  indexCache.delete(dir);
  ensureIndexFresh(dir);
}

/**
 * 统一打分检索入口：按 score 取 Top-K（K=RETRIEVE_TOP_K，默认 12）。
 * - 缺省对 `<historyDir>` 五维记忆 .md 文件检索：查询前惰性增量（ensureIndexFresh）；
 * - opts.corpus 提供时对内存语料直评（chat.ts retrieveRelevant 的 LoadedMemories 路径，
 *   不落盘、零写入路径改动），historyDir 忽略。
 */
export function searchScored(
  query: string,
  historyDir: string,
  opts: SearchOptions = {},
): ScoredHit[] {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  let paragraphs: Paragraph[];
  if (opts.corpus) {
    paragraphs = corpusToParagraphs(opts.corpus);
  } else {
    ensureIndexFresh(historyDir);
    paragraphs = flattenIndex(indexCache.get(path.resolve(historyDir)) ?? { version: INDEX_VERSION, files: {} });
  }
  return scoreParagraphs(query, paragraphs, topK);
}

// ===== 截断蒸馏装配 =====

/** 蒸馏实现注入点（缺省 null = 无 Key/无桩 → 直截断；仅测试与内部使用） */
let distillImpl: DistillImpl | null = null;

/**
 * 测试注入点：替换蒸馏实现（缺省 = 无 Key/无桩时直截断；null 恢复缺省）。
 * 蒸馏实现自身负责网络调用（唯一白名单既有 chat() 端点；本模块零网络面）。
 */
export function __setDistillImpl(impl: DistillImpl | null): void {
  distillImpl = impl ?? null;
}

/** 蒸馏成功记台账（kind='distill'；经 chat.recordTokenUsage，动态 import 规避 chat↔retrieval 加载环） */
async function recordDistillUsage(promptTokens: number, completionTokens: number): Promise<void> {
  try {
    const chat = (await import('./chat')) as typeof import('./chat');
    await chat.recordTokenUsage({ promptTokens, completionTokens, source: 'real', kind: 'distill' });
  } catch {
    // 台账失败不阻塞检索主流程
  }
}

/**
 * 同步装配核心：命中行（`[source] text`，行级 clip 120 对齐现状）按序累加至预算；
 * 预算耗尽处的命中按剩余空间直截断（省略号结尾）。无蒸馏路径（retrieveRelevant 同步口径）。
 */
export function assembleHitLines(hits: readonly ScoredHit[], budgetChars: number): InjectionResult {
  const parts: string[] = [];
  let total = 0;
  for (const hit of hits) {
    const line = `[${hit.source}] ${hit.text}`;
    const candidate = line.length > HIT_LINE_CHAR_LIMIT ? clip(line, HIT_LINE_CHAR_LIMIT) : line;
    if (!candidate) continue;
    const sep = parts.length > 0 ? '\n' : '';
    if (total + sep.length + candidate.length <= budgetChars) {
      parts.push(candidate);
      total += sep.length + candidate.length;
      continue;
    }
    const remaining = budgetChars - total - sep.length;
    if (remaining > 0) parts.push(clip(candidate, remaining));
    break; // 预算耗尽
  }
  return { injection: parts.join('\n'), distilledCount: 0, fellBack: false };
}

/**
 * 检索命中装配（chat.ts retrieveRelevant 内部改接的目标入口）：
 * searchScored → 按序累加至预算；被行级截断的超预算长命中交给 __setDistillImpl 蒸馏
 * （产物标注「（摘要）」），净省判据不满足（estimateTokens(原文)-estimateTokens(摘要)
 * ≤ promptTokens+completionTokens，净亏）→ 回退直截断；无蒸馏实现（未注入/无 Key 场景）→ 直截断。
 * 每次蒸馏成功记台账 kind='distill'。
 */
export async function assembleInjection(
  query: string,
  historyDir: string,
  opts: { budgetChars?: number; topK?: number; corpus?: readonly CorpusItem[] } = {},
): Promise<InjectionResult> {
  const budgetChars = opts.budgetChars ?? RETRIEVE_LAYER_CHAR_LIMIT;
  const hits = searchScored(query, historyDir, { topK: opts.topK, corpus: opts.corpus });
  if (!distillImpl) {
    return assembleHitLines(hits, budgetChars);
  }
  const parts: string[] = [];
  let total = 0;
  let distilledCount = 0;
  let fellBack = false;
  for (const hit of hits) {
    const line = `[${hit.source}] ${hit.text}`;
    let candidate = line;
    if (line.length > HIT_LINE_CHAR_LIMIT) {
      // 行级会被截断的长命中 → 蒸馏候选（净省则摘要替换，否则回退直截断）
      let distilled = false;
      try {
        const r = await distillImpl(hit.text, { budgetChars: HIT_LINE_CHAR_LIMIT });
        const summary = r && typeof r.summary === 'string' ? r.summary : '';
        if (summary) {
          const saving = estimateTokens(hit.text) - estimateTokens(summary);
          const cost = Math.max(0, r.promptTokens) + Math.max(0, r.completionTokens);
          if (saving > cost) {
            const summaryLine = summary.startsWith(DISTILL_MARK) ? summary : DISTILL_MARK + summary;
            candidate = clip(summaryLine, HIT_LINE_CHAR_LIMIT);
            distilledCount += 1;
            distilled = true;
            await recordDistillUsage(r.promptTokens, r.completionTokens);
          }
        }
      } catch {
        // 蒸馏异常按净亏处理 → 回退直截断
      }
      if (!distilled) {
        fellBack = true;
        candidate = clip(line, HIT_LINE_CHAR_LIMIT);
      }
    }
    if (!candidate) continue;
    const sep = parts.length > 0 ? '\n' : '';
    if (total + sep.length + candidate.length <= budgetChars) {
      parts.push(candidate);
      total += sep.length + candidate.length;
      continue;
    }
    const remaining = budgetChars - total - sep.length;
    if (remaining > 0) parts.push(clip(candidate, remaining));
    break; // 预算耗尽
  }
  return { injection: parts.join('\n'), distilledCount, fellBack };
}
