/**
 * 记忆归档提取模块（离线规则版）· 第 3 期修复
 *
 * 修复点（对应《ThatPerson记忆上下文失控分析与改进方案》3c）：
 * - 经历改用「动宾短语」提取：不再被语气词「去啊」劫持，「今天去打篮球」归档为「打篮球」。
 * - 负向偏好回溯过滤场景词：对象为「燕麦拿铁」而非「咖啡馆」。
 * - 补全感受词表：松弛/治愈/解压/痛快/上头/舒畅/尽兴/安心/踏实/过瘾 等。
 * - 假模式消除：单条消息不再产出「模式」；改为跨 ≥2 轮/天的 `detectCrossTurnPatterns`。
 *
 * 仍为离线规则版，不调用任何 API，不消耗 Key。
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
  ['健身', '运动'],
  ['瑜伽', '运动'],
  ['跑步', '运动'],
  ['篮球', '运动'],
  ['羽毛球', '运动'],
  ['游泳', '运动'],
  ['爬山', '运动'],
  ['骑行', '运动'],
  ['看书', '阅读'],
  ['读书', '阅读'],
  ['电影', '电影'],
  ['追剧', '追剧'],
  ['游戏', '游戏'],
  ['唱歌', '音乐'],
  ['听歌', '音乐'],
  ['音乐', '音乐'],
  ['工作', '工作'],
  ['上班', '工作'],
  ['加班', '工作'],
  ['上课', '学习'],
  ['考试', '考试'],
  ['面试', '求职'],
  ['毕业', '毕业'],
  ['搬家', '搬家'],
  ['旅行', '旅行'],
  ['旅游', '旅行'],
  ['猫', '宠物'],
  ['狗', '宠物'],
  ['做饭', '做饭'],
  ['美食', '美食'],
  ['生日', '生日'],
  ['纪念日', '纪念日'],
  ['熬夜', '作息'],
  ['睡觉', '作息'],
];

/** 场景词：负向偏好回溯时需过滤的地点/行为场景（3c） */
const SCENE_WORDS = /咖啡馆|咖啡店|店里|楼下|附近|那边|餐厅|商场|超市|书店|健身房|办公室|公司|学校|家里|外面|路上/;

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
  if (/(运动|健身|瑜伽|跑步|锻炼|篮球|羽毛球|游泳|爬山|骑行)/.test(text)) {
    push('#运动偏好');
  }
  if (/(周末|看书|读书|电影|追剧|旅行|旅游|游戏|音乐|唱歌|听歌)/.test(text)) {
    push('#生活方式');
  }
  if (/(工作|上班|加班|公司|同事|老板)/.test(text)) {
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

/** 负向偏好缺少对象时，向前回溯最近分隔符前的名词短语（3c：过滤场景词，对象=燕麦拿铁≠咖啡馆） */
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
  let chunk = (lastSep === -1 ? before : before.slice(0, lastSep)).trim();
  chunk = chunk
    .replace(/^(?:我|今天|昨天|前天|周末|去|去了|试了|试过|喝了|吃过|看了|还是|真的|有点|有些|就是|比较|顺便|顺便去)+/, '')
    .trim();
  // 场景词只留其后的部分（「咖啡馆试了燕麦拿铁」→「试了燕麦拿铁」）
  const parts = chunk.split(SCENE_WORDS);
  chunk = parts[parts.length - 1].trim();
  chunk = chunk.replace(/^(?:试了|试过|喝了|吃过|看了|买了|尝了|尝试|吃了|点了|叫了|来了|去了)+/, '').trim();
  chunk = chunk.replace(/[的了呢啊吧都就是]+$/, '').trim();
  return chunk.slice(-12);
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

// ===== 经历提取（3c：动宾短语） =====

/** 单字动词（语气词「去啊」不在此列；「去」仅在与宾语相连时视为动作） */
const SINGLE_VERBS = '打看玩吃喝听踢游泳学买做上读写逛跑爬骑唱练试办';
/** 多字动词（优先匹配） */
const MULTI_VERBS = /(?:参加|体验|练习|毕业|入职|搬家|开始|准备|学会|尝试|坚持|错过|完成|看完|看完|吃过|喝过|去过|试过|走过|路过|出差|开会|约了|点了)/;

const STRONG_FEEL =
  /(开心|高兴|兴奋|舒服|放松|松弛|治愈|解压|痛快|上头|舒畅|尽兴|安心|踏实|过瘾|满意|享受|上瘾|推荐|值得|太棒|好棒|很棒|超棒|超喜欢|好喜欢|很喜欢|喜欢|有趣|有意思|幸福|满足|惊喜|好看|好吃|好玩|好用|爽)/;
const FEEL_WORDS =
  /(开心|高兴|兴奋|舒服|放松|松弛|治愈|解压|痛快|上头|舒畅|尽兴|安心|踏实|过瘾|满意|享受|上瘾|推荐|值得|太棒|好棒|很棒|超棒|超喜欢|好喜欢|很喜欢|喜欢|有趣|有意思|幸福|满足|惊喜|好看|好吃|好玩|好用|爽|累|紧张|难过|难受|烦|委屈|失望|遗憾|辛苦|还行|一般|不错|挺好|很好|有点|感觉|体验|新奇|新鲜|奇怪)/;

/** 从「感受词之前的文本」中提取离感受词最近的动宾短语 */
function extractVerbPhrase(beforeFeel: string): string {
  const candidates: Array<{ index: number; verb: string }> = [];
  let m: RegExpExecArray | null;
  const multiRe = new RegExp(MULTI_VERBS.source, 'g');
  while ((m = multiRe.exec(beforeFeel)) !== null) {
    candidates.push({ index: m.index, verb: m[0] });
    multiRe.lastIndex = m.index + Math.max(m[0].length, 1);
  }
  for (let i = 0; i < SINGLE_VERBS.length; i += 1) {
    const verb = SINGLE_VERBS[i];
    let pos = beforeFeel.indexOf(verb);
    while (pos !== -1) {
      candidates.push({ index: pos, verb });
      pos = beforeFeel.indexOf(verb, pos + 1);
    }
  }
  if (candidates.length === 0) return '';
  // 取最后一个动词（离感受词最近）
  candidates.sort((a, b) => b.index - a.index);
  const hit = candidates[0];
  // 从动词到最近的逗号/句号前（在 beforeFeel 内）
  let tail = beforeFeel.slice(hit.index);
  const sepIdx = tail.search(/[，,；;。]/);
  if (sepIdx !== -1) tail = tail.slice(0, sepIdx);
  let phrase = tail.trim();
  // 清洗：去掉尾部的「了/过/一下/了一会儿」与句末语气
  phrase = phrase.replace(/(?:了|过|一下|了一会儿|了一会儿|了一下|了会儿)+$/, '');
  phrase = phrase.replace(/[的了呢啊吧]+$/, '');
  // 动词「去/试/上」等单独出现时保留（如「去健身」）
  return phrase.length >= 2 ? phrase : '';
}

/** 从用户文本提取经历条目（行为动词 + 感受词，3c 动宾短语版） */
function extractExperiences(userText: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const sentence of splitSentences(userText)) {
    const feel = sentence.match(FEEL_WORDS);
    if (!feel) continue;
    const feelIndex = feel.index ?? 0;
    const beforeFeel = sentence.slice(0, feelIndex);
    const actionPart = extractVerbPhrase(beforeFeel);
    if (!actionPart) continue;
    let feelWord = feel[0];
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
  { re: /我在([^，。！！?;；\n]{1,12})/g, describe: (m) => '用户所在地：' + m[1] + '。' },
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

// ===== 模式提取（3c：仅跨 ≥2 轮/天，单条消息不产出） =====

/**
 * 跨轮模式检测：仅当某主题在 ≥2 条不同消息（跨轮/跨天）中出现时才记为「模式」。
 * 单条消息内多次提及（如 BC-4 的三次咖啡）不会产出模式条目。
 */
export function detectCrossTurnPatterns(userTexts: string[]): ArchiveEntry[] {
  const totalCounts = new Map<string, number>();
  const turnCounts = new Map<string, number>();
  for (const text of userTexts) {
    if (!text || !text.trim()) continue;
    const seenInTurn = new Set<string>();
    const counts = countTopicOccurrences(text);
    counts.forEach((n, topic) => {
      totalCounts.set(topic, (totalCounts.get(topic) || 0) + n);
      if (!seenInTurn.has(topic)) {
        seenInTurn.add(topic);
        turnCounts.set(topic, (turnCounts.get(topic) || 0) + 1);
      }
    });
  }
  const entries: ArchiveEntry[] = [];
  const ranked: Array<[string, number]> = [];
  turnCounts.forEach((turns, topic) => {
    if (turns >= 2 && (totalCounts.get(topic) || 0) >= 2) ranked.push([topic, turns]);
  });
  ranked.sort((a, b) => b[1] - a[1]);
  for (const [topic] of ranked.slice(0, 2)) {
    const idx = firstTopicIndex(userTexts.join('\n'), topic);
    if (idx === -1) continue;
    const dialog = dialogSnippet(userTexts.join('\n'), idx, 24);
    entries.push({
      type: '模式',
      dialog,
      insight: '用户近几轮多次提及「' + topic + '」（跨 ' + turnCounts.get(topic) + ' 轮），形成稳定的兴趣或行为模式。',
      confidence: '中',
      tags: ['#' + topic, '#模式'],
    });
  }
  return entries;
}

// ===== 对外主函数 =====

/**
 * 从本轮对话提取归档条目（离线规则版，不调用任何 API）。
 * 单条消息不产出「模式」；跨轮模式请调用 detectCrossTurnPatterns。
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
  return dedupe(entries);
}

// ===== 每日摘要 =====

const MOOD_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(焦虑|担心|紧张|害怕|压力(?:大|好大)|不安|失眠|慌了)/, '焦虑'],
  [/(难过|低落|伤心|不开心|沮丧|emo|委屈|烦(?:死|透)?|好累|累死|疲惫|丧|失落|孤单|孤独)/, '低落'],
  [/(开心|高兴|兴奋|太棒|好棒|超开心|好开心|开心死|兴奋死|哈哈|嘻嘻|超喜欢|太喜欢)/, '兴奋'],
  [/(舒服|放松|惬意|安逸|轻松|自在|舒坦|松弛|治愈|解压|痛快|尽兴)/, '轻松'],
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