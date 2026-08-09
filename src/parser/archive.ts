/**
 * 记忆归档提取模块（离线规则版）
 *
 * 依据《关于ThatGirl-Agent项目第一版提示词》v3.0 第 4.2 / 4.3 节实现：
 * - extractArchives：基于规则启发式从本轮对话中提取偏好/经历/日期/身份/模式，绝不调用任何 API。
 * - buildSessionSummary：生成每日对话摘要（主题、情绪基调、新增记忆、待跟进事项）。
 *
 * 设计说明（数据工程师视角）：
 * - 全部为正则 + 关键词启发式，可离线运行，不消耗 API Key。
 * - 置信度遵循契约：高=明确陈述，中=多次推断，低=单次暗示。
 * - dialog 一律截取用户原话片段，保留关键词上下文。
 */

import type {
  ArchiveEntry,
  ArchiveType,
  Confidence,
  SessionSummary,
} from '../memory/types';

/** 句子边界标点 */
const SENTENCE_END = /[\n。！？!?；;]/;

/** 主题关键词表：关键词 -> 主题短语 */
const TOPIC_KEYWORDS: ReadonlyArray<readonly [string, string]> = [
  ['咖啡', '咖啡'],
  ['拿铁', '咖啡'],
  ['美式', '咖啡'],
  ['奶茶', '奶茶'],
  ['茶', '茶饮'],
  ['运动', '运动'],
  ['健身', '健身'],
  ['瑜伽', '瑜伽'],
  ['跑步', '跑步'],
  ['看书', '阅读'],
  ['读书', '阅读'],
  ['电影', '电影'],
  ['追剧', '追剧'],
  ['工作', '工作'],
  ['上班', '工作'],
  ['公司', '公司'],
  ['周末', '周末安排'],
  ['旅行', '旅行'],
  ['旅游', '旅行'],
  ['猫', '宠物'],
  ['狗', '宠物'],
  ['做饭', '做饭'],
  ['美食', '美食'],
  ['考试', '考试'],
  ['面试', '求职'],
  ['毕业', '毕业'],
  ['搬家', '搬家'],
  ['生日', '生日'],
  ['纪念日', '纪念日'],
  ['熬夜', '作息'],
  ['睡觉', '作息'],
];

// ===== 基础工具 =====

/** 计算句子边界 [start, end) */
function sentenceBounds(text: string, index: number): [number, number] {
  let start = index;
  while (start > 0 && !SENTENCE_END.test(text[start - 1])) {
    start -= 1;
  }
  let end = index;
  while (end < text.length && !SENTENCE_END.test(text[end])) {
    end += 1;
  }
  return [start, end];
}

/** 截取包含关键词的原话片段，保留上下文并控制长度 */
function dialogSnippet(text: string, index: number, radius = 24): string {
  const [start, end] = sentenceBounds(text, index);
  const sentence = text.slice(start, end).trim();
  if (sentence.length <= 60) {
    return sentence;
  }
  const from = Math.max(0, index - radius);
  const to = Math.min(text.length, index + radius);
  let snippet = text.slice(from, to);
  snippet = snippet.replace(/^[^，,。！？!?；;\w\u4e00-\u9fa5]+/, '');
  snippet = snippet.replace(/[，,。！？!?；;\s]+$/, '');
  return snippet;
}

/** 按句子边界切分文本 */
function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_END)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 按逗号/句号等切分（日期提取专用，便于把不同日期拆成独立条目） */
function splitClauses(text: string): string[] {
  return text
    .split(/[\n，,。！？!?；;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
/** 统计主题关键词出现次数 */
function countTopicOccurrences(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [keyword, topic] of TOPIC_KEYWORDS) {
    let pos = 0;
    let n = 0;
    for (;;) {
      const idx = text.indexOf(keyword, pos);
      if (idx === -1) break;
      n += 1;
      pos = idx + keyword.length;
    }
    if (n > 0) {
      counts.set(topic, (counts.get(topic) || 0) + n);
    }
  }
  return counts;
}

/** 查找某主题首次出现的原文位置 */
function firstTopicIndex(text: string, topic: string): number {
  for (const [keyword, t] of TOPIC_KEYWORDS) {
    if (t === topic) {
      const idx = text.indexOf(keyword);
      if (idx !== -1) return idx;
    }
  }
  return -1;
}

/** 生成标签 */
function makeTags(text: string, type: ArchiveType): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const push = (tag: string): void => {
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  };
  for (const [keyword, topic] of TOPIC_KEYWORDS) {
    if (text.includes(keyword)) {
      push('#' + topic);
    }
  }
  if (/(吃|喝|咖啡|拿铁|奶茶|茶|菜|饭|火锅|甜点|美食)/.test(text)) {
    push('#饮食偏好');
  }
  if (/(运动|健身|瑜伽|跑步|锻炼)/.test(text)) {
    push('#运动偏好');
  }
  if (/(周末|看书|读书|电影|追剧|旅行|旅游)/.test(text)) {
    push('#生活方式');
  }
  if (/(工作|上班|公司|同事|老板)/.test(text)) {
    push('#职业');
  }
  if (tags.length === 0) {
    push(type === '身份' ? '#身份' : '#个人');
  }
  return tags;
}

/** 清理捕获的对象文本 */
function cleanObject(raw: string): string {
  let obj = raw.replace(/^(的|了|呢|啊|吧|都|就|还|也)/, '').trim();
  obj = obj.replace(/[的了呢啊吧都就是]+$/, '');
  return obj;
}

/** 按 类型+提炼 去重 */
function dedupe(entries: ArchiveEntry[]): ArchiveEntry[] {
  const seen = new Set<string>();
  const out: ArchiveEntry[] = [];
  for (const entry of entries) {
    const key = entry.type + '|' + entry.insight;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

// ===== 偏好提取 =====

interface PrefRule {
  re: RegExp;
  polarity: 'pos' | 'neg';
  confidence: Confidence;
}

interface PrefHit {
  entry: ArchiveEntry;
  polarity: 'pos' | 'neg';
  object: string;
}

const PREF_RULES: PrefRule[] = [
  // —— 明确陈述：置信度高 ——
  { re: /(?:我)?不喜欢([^，。！？!?；;、\n]{0,16})/g, polarity: 'neg', confidence: '高' },
  { re: /(?:我)?(?:真的|有点|有些)?不太喜欢([^，。！？!?；;、\n]{0,16})/g, polarity: 'neg', confidence: '高' },
  { re: /(?:我)?讨厌([^，。！？!?；;、\n]{0,16})/g, polarity: 'neg', confidence: '高' },
  { re: /(?:我)?不(?:爱|吃|喝|爱喝|爱吃)([^，。！？!?；;、\n]{0,16})/g, polarity: 'neg', confidence: '高' },
  { re: /(?:我)?(?:还是|就|也|真|都|其实|确实)?(?:更|比较|挺|蛮|特别|非常|真的|最|超|就|还)?(?:喜欢|爱|偏爱|偏好|中意|钟意|享受|喜欢喝|喜欢吃)([^，。！？!?；;、\n]{0,16})/g, polarity: 'pos', confidence: '高' },
  // —— 习惯 / 推断：置信度中 ——
  { re: /我(?:有)?(?:个)?习惯(?:了|是)?([^，。！？!?；;、\n]{0,16})/g, polarity: 'pos', confidence: '中' },
  { re: /(?:我)?(?:每天|经常|总是|习惯性|每天早上|每晚)([^，。！？!?；;、\n]{0,16})/g, polarity: 'pos', confidence: '中' },
];

/** 负向偏好缺少对象时，向前回溯最近分隔符前的名词短语（如「不太喜欢」→「燕麦拿铁」） */
function backtrackObject(text: string, matchIndex: number): string {
  const before = text.slice(0, matchIndex);
  const lastSep = Math.max(
    before.lastIndexOf('，'),
    before.lastIndexOf(','),
    before.lastIndexOf('。'),
    before.lastIndexOf('、'),
    before.lastIndexOf('；'),
    before.lastIndexOf('\n'),
  );
  const chunk = (lastSep === -1 ? before : before.slice(0, lastSep)).trim();
  const cleaned = chunk
    .replace(/^(?:我|今天|昨天|前天|去|去了|试了|试过|喝了|吃过|看了|还是|真的|有点|有些|就是|比较|楼下)+/, '')
    .trim();
  return cleaned.slice(-10);
}
/** 从用户文本提取偏好条目 */
function extractPrefs(userText: string): PrefHit[] {
  const hits: PrefHit[] = [];
  const seen = new Set<string>();
  for (const rule of PREF_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(userText)) !== null) {
      const pos = m.index;
      const key = rule.polarity + '@' + pos;
      if (seen.has(key)) {
        rule.re.lastIndex = pos + 1;
        continue;
      }
      seen.add(key);
      const object = cleanObject(m[1] || '');
      // 正向偏好无明确对象时跳过（避免「喜欢，」式误报）；负向偏好回溯前文取对象
      if (!object && rule.polarity === 'pos') {
        rule.re.lastIndex = m.index + Math.max(m[0].length, 1);
        continue;
      }
      const target = object || backtrackObject(userText, m.index);
      const polarityText = rule.polarity === 'pos' ? '喜欢' : '不喜欢';
      const insight =
        rule.confidence === '高'
          ? '用户' + polarityText + (target ? '「' + target + '」' : '') + '，明确陈述。'
          : '用户可能习惯「' + (target || '某事物') + '」，从日常表述推断。';
      const dialog = dialogSnippet(userText, pos, 24);
      const entry: ArchiveEntry = {
        type: '偏好',
        dialog,
        insight,
        confidence: rule.confidence,
        tags: makeTags(dialog + object, '偏好'),
      };
      hits.push({ entry, polarity: rule.polarity, object });
      rule.re.lastIndex = m.index + Math.max(m[0].length, 1);
    }
  }
  return hits;
}
/** 判断两个偏好对象是否同主题 */
function sameTopic(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  for (const [keyword] of TOPIC_KEYWORDS) {
    if (keyword.length >= 2 && a.includes(keyword) && b.includes(keyword)) return true;
  }
  return false;
}

/** 偏好冲突标注（提示词 4.2 archiving_rules） */
function detectConflicts(prefs: PrefHit[]): void {
  for (let i = 0; i < prefs.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const prev = prefs[j];
      const cur = prefs[i];
      if (prev.polarity === cur.polarity) continue;
      if (sameTopic(prev.object, cur.object)) {
        cur.entry.conflict = '与同主题记录「' + prev.entry.dialog + '」表述相反，保留待确认。';
      }
    }
  }
}

// ===== 经历提取 =====

const ACTION_HINTS = /今天|昨天|前天|上周|周末|最近|刚|刚刚|去(?:了|过|了趟)?|试(?:了|过)?|做(?:了|过)?|参加(?:了|过)?|毕业|入职|搬家|看(?:了|过|了场|了部)?|吃(?:了|过)?|喝(?:了|过)?|玩(?:了|过)?/;
const STRONG_FEEL = /(开心|高兴|兴奋|舒服|放松|满意|享受|上瘾|推荐|值得|太棒|好棒|很棒|超棒|超喜欢|好喜欢|很喜欢|喜欢|有趣|有意思|幸福|满足|惊喜|好看|好吃|好玩|好用)/;
const FEEL_WORDS = /(开心|高兴|兴奋|舒服|放松|满意|享受|上瘾|推荐|值得|太棒|好棒|很棒|超棒|超喜欢|好喜欢|很喜欢|喜欢|有趣|有意思|幸福|满足|惊喜|好看|好吃|好玩|好用|累|紧张|难过|难受|烦|委屈|失望|遗憾|辛苦|还行|一般|不错|挺好|很好|有点|感觉|体验|新奇|新鲜|奇怪)/;

/** 从用户文本提取经历条目（行为动词 + 感受词） */
function extractExperiences(userText: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const sentence of splitSentences(userText)) {
    const trigger = sentence.match(ACTION_HINTS);
    if (!trigger) continue;
    const feel = sentence.match(FEEL_WORDS);
    if (!feel) continue;
    const act = trigger[0];
    const actIndex = sentence.indexOf(act);
    const actionPart = sentence
      .slice(actIndex)
      .split(/[，,]/)[0]
      .trim()
      .slice(0, 30);
    if (actionPart.length < 2) continue;
    let feelWord = feel[0];
    const feelIndex = feel.index ?? 0;
    if (/[不没]/.test(sentence.slice(Math.max(0, feelIndex - 2), feelIndex))) {
      feelWord = '不' + feelWord.replace(/^不/, '');
    }
    const confidence: Confidence = STRONG_FEEL.test(sentence) ? '高' : '中';
    entries.push({
      type: '经历',
      dialog: sentence,
      insight: '用户' + actionPart + '，感受：' + feelWord + '。',
      confidence,
      tags: makeTags(sentence, '经历'),
    });
    if (entries.length >= 4) break;
  }
  return entries;
}

// ===== 日期提取 =====

const DATE_TIME_HINTS = /\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}号|\d{1,2}月|\d{1,2}日|下(?:周|个)(?:一|二|三|四|五|六|日|天)|这(?:周|个)(?:一|二|三|四|五|六|日|天)|周末|下周|这周|下个月|这个月|后天|明天|大后天|年底|月初|月底|几号/;
const DATE_SPECIFIC = /\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}号|下(?:周|个)(?:一|二|三|四|五|六|日|天)|这(?:周|个)(?:一|二|三|四|五|六|日|天)|明天|后天|大后天/;

/** 从用户文本提取日期条目 */
function extractDates(userText: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  for (const clause of splitClauses(userText)) {
    const eventMatches = clause.match(/生日|纪念日|考试|面试|报名|截止|几号|周年|体检|复查|预约|deadline|DDL|交作业|提交|到期/g);
    const timeMatch = clause.match(DATE_TIME_HINTS);
    if (!eventMatches) continue;
    const events = eventMatches ? Array.from(new Set(eventMatches)).slice(0, 2) : [];
    const eventText = events.length > 0 ? events.join('、') : '重要日程';
    const time = timeMatch ? timeMatch[0] : '';
    const confidence: Confidence = DATE_SPECIFIC.test(clause) ? '高' : '中';
    const key = clause;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      type: '日期',
      dialog: clause,
      insight: '用户的重要日期：' + eventText + (time ? '（' + time + '）' : '') + '。',
      confidence,
      tags: makeTags(clause, '日期'),
    });
  }
  return entries;
}
// ===== 身份提取 =====

interface IdentityRule {
  re: RegExp;
  describe: (m: RegExpExecArray) => string;
}

const IDENTITY_RULES: IdentityRule[] = [
  { re: /我是做([^，。！？!?；;、\n]{1,14})/g, describe: (m) => '用户从事' + m[1] + '相关工作。' },
  { re: /我叫([^，。！？!?；;、\n]{1,12})/g, describe: (m) => '用户名字：' + m[1] + '。' },
  { re: /我今年(\d{1,3})(?:岁)?/g, describe: (m) => '用户今年 ' + m[1] + ' 岁。' },
  { re: /我是([^，。！？!?；;、\n]{1,12})/g, describe: (m) => '用户身份：' + m[1] + '。' },
  { re: /我工作([^，。！？!?；;、\n]{1,14})/g, describe: (m) => '用户工作情况：' + m[1] + '。' },
  { re: /我住在([^，。！？!?；;、\n]{1,12})/g, describe: (m) => '用户住在' + m[1] + '。' },
  { re: /我在([^，。！？!?；;、\n]{1,12})/g, describe: (m) => '用户所在地：' + m[1] + '。' },
];

/** 从用户文本提取身份条目 */
function extractIdentities(userText: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const rule of IDENTITY_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(userText)) !== null) {
      const pos = m.index;
      const dialog = dialogSnippet(userText, pos, 20);
      entries.push({
        type: '身份',
        dialog,
        insight: rule.describe(m),
        confidence: '高',
        tags: makeTags(dialog, '身份'),
      });
      rule.re.lastIndex = m.index + Math.max(m[0].length, 1);
    }
  }
  return entries;
}

// ===== 模式提取 =====

/** 同主题出现 >= 2 次时提取为「模式」 */
function extractPatterns(userText: string): ArchiveEntry[] {
  const counts = countTopicOccurrences(userText);
  const repeated: Array<[string, number]> = [];
  counts.forEach((n, topic) => {
    if (n >= 2) repeated.push([topic, n]);
  });
  repeated.sort((a, b) => b[1] - a[1]);
  const entries: ArchiveEntry[] = [];
  for (const [topic, n] of repeated.slice(0, 2)) {
    const idx = firstTopicIndex(userText, topic);
    if (idx === -1) continue;
    const dialog = dialogSnippet(userText, idx, 24);
    entries.push({
      type: '模式',
      dialog,
      insight: '用户本次对话多次提及「' + topic + '」（共 ' + n + ' 次），形成稳定的兴趣或行为模式。',
      confidence: '中',
      tags: ['#' + topic, '#模式'],
    });
  }
  return entries;
}

// ===== 对外主函数 =====

/**
 * 从本轮对话提取归档条目（离线规则版，不调用任何 API）。
 * assistantText 保留契约签名，当前规则仅以用户原话为准。
 */
export function extractArchives(userText: string, assistantText: string): ArchiveEntry[] {
  const text = (userText || '').trim();
  if (text.length === 0) return [];
  const prefs = extractPrefs(text);
  detectConflicts(prefs);
  const entries: ArchiveEntry[] = [];
  for (const hit of prefs) entries.push(hit.entry);
  entries.push(...extractExperiences(text));
  entries.push(...extractDates(text));
  entries.push(...extractIdentities(text));
  entries.push(...extractPatterns(text));
  return dedupe(entries);
}

// ===== 每日摘要 =====

const MOOD_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(焦虑|担心|紧张|害怕|压力(?:大|好大)|不安|失眠|慌了)/, '焦虑'],
  [/(难过|低落|伤心|不开心|沮丧|emo|委屈|烦(?:死|透)?|好累|累死|疲惫|丧|失落|孤单|孤独)/, '低落'],
  [/(开心|高兴|兴奋|太棒|好棒|超开心|好开心|开心死|兴奋死|哈哈|嘻嘻|超喜欢|太喜欢)/, '兴奋'],
  [/(舒服|放松|惬意|安逸|轻松|自在|舒坦)/, '轻松'],
];

/** 情绪基调映射：焦虑 > 低落 > 兴奋 > 轻松 > 平静 */
function detectMood(text: string): string {
  for (const [re, mood] of MOOD_RULES) {
    if (re.test(text)) return mood;
  }
  return '平静';
}

const IGNORED_TOPIC_TAGS = new Set(['饮食偏好', '运动偏好', '生活方式', '职业', '身份', '重要日期', '个人', '模式']);

/** 提取 2-5 个核心话题 */
function extractTopics(userText: string, archives: ArchiveEntry[]): string[] {
  const topics: string[] = [];
  const counts = countTopicOccurrences(userText);
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [topic] of ranked) {
    topics.push(topic);
    if (topics.length >= 5) break;
  }
  if (topics.length < 2) {
    for (const archive of archives) {
      for (const tag of archive.tags) {
        const name = tag.replace(/^#/, '');
        if (!IGNORED_TOPIC_TAGS.has(name) && !topics.includes(name)) {
          topics.push(name);
        }
        if (topics.length >= 2) break;
      }
      if (topics.length >= 2) break;
    }
  }
  if (topics.length === 0) topics.push('日常分享');
  return topics.slice(0, 5);
}

const FOLLOWUP_HINTS = /(下次|改天|准备|打算|计划|记得|一定要|想(?:去|试|看|学|买|做|要|着)|准备去|打算去|该去|要去)/;
const FOLLOWUP_EXCLUDE = /(昨天|前天|上周|已经|完了|过了|结束了|去过了|吃过了|看过了)/;

/** 识别未完成/待跟进事项 */
function extractFollowUps(userText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sentence of splitSentences(userText)) {
    if (!FOLLOWUP_HINTS.test(sentence)) continue;
    if (FOLLOWUP_EXCLUDE.test(sentence)) continue;
    const clean = sentence.replace(/^(我|嗯|对了|然后)/, '').trim();
    if (clean.length < 4 || clean.length > 40) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 生成每日对话摘要（提示词 4.3）。
 * newMemories 格式：类型 | 内容 | 置信度。
 * assistantText 保留契约签名，当前情绪基调仅以用户原话为准。
 */
export function buildSessionSummary(
  date: string,
  userText: string,
  assistantText: string,
  archives: ArchiveEntry[],
): SessionSummary {
  const text = userText || '';
  return {
    date,
    topics: extractTopics(text, archives),
    mood: detectMood(text),
    newMemories: archives.map((a) => a.type + ' | ' + a.insight + ' | ' + a.confidence),
    followUps: extractFollowUps(text),
  };
}
