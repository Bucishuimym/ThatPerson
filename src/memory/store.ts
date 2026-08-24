/**
 * 记忆存储实现（依据《关于ThatPerson-Agent项目第一版提示词》v3.0）
 * 提示词 2.1 存储结构 / 2.2 读取流程 / 4.2 归档格式 / 4.3 每日摘要格式
 * 第 3 期新增（3d）：标签合并（>5 条折叠）、跨会话去重、低置信度 30 天衰减、
 *                    每文件软上限 100 条 + 硬上限校验。
 */
import fs from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  ArchiveEntry,
  ArchiveType,
  Confidence,
  LoadedMemories,
  MemorySection,
  MemoryStore,
  SECTION_FILES,
  SessionSummary,
} from './types';

/** 每文件归档条目软上限（3d），超过即触发压缩合并 */
export const ARCHIVE_FILE_SOFT_CAP = 100;
/** 低置信度条目衰减周期（天），30 天前的「低」置信度记忆失效移除 */
export const LOW_CONFIDENCE_TTL_DAYS = 30;

/** 归档类型 → 目标文件（相对 history/，固定映射，杜绝路径穿越） */
const ARCHIVE_TARGETS: Record<ArchiveType, string> = {
  偏好: path.join('profile', 'preferences.md'),
  经历: path.join('experiences', 'journal.md'),
  日期: path.join('timeline', 'important_dates.md'),
  身份: path.join('profile', 'identity.md'),
  模式: path.join('insights', 'patterns.md'),
};

/** 允许写入归档的 section 白名单（session_logs 只能通过 appendSessionLog 写入） */
const ARCHIVE_SECTIONS: ReadonlySet<MemorySection> = new Set<MemorySection>([
  'profile',
  'timeline',
  'experiences',
  'insights',
]);

/** 会话摘要文件名的日期格式（YYYY-MM-DD） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 本地时区 YYYY-MM-DD */
function localDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = two(now.getMonth() + 1);
  const day = two(now.getDate());
  return `${year}-${month}-${day}`;
}

/** 日期偏移（按字符串计算，用于低置信度衰减；输入 YYYY-MM-DD，输出 YYYY-MM-DD） */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${two(dt.getMonth() + 1)}-${two(dt.getDate())}`;
}

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 读取文件，不存在返回 null（提示词 2.2：缺失文件跳过，不创建空文件） */
function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/** 取文件末尾最后一个 `## YYYY-MM-DD` 日期标题；没有则返回 null */
function lastDateHeader(content: string): string | null {
  const headerRe = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(content)) !== null) {
    last = match[1];
  }
  return last;
}

/** 保证内容以空行结尾（空串原样返回），用于合并归档时对齐格式 */
function ensureTrailingBlank(content: string): string {
  if (content === '') return '';
  if (content.endsWith('\n\n')) return content;
  if (content.endsWith('\n')) return `${content}\n`;
  return `${content}\n\n`;
}

/** 清洗写盘字段：转义 XML/Markdown 控制字符、折叠换行，防标签闭合与伪造条目（安全红线 5） */
function sanitizeForMarkdown(text: string): string {
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 提示词 4.2 归档条目正文（不含日期标题） */
function formatArchiveEntry(entry: ArchiveEntry): string {
  const lines = [
    `### [归档类型：${entry.type}]`,
    '',
    `- **原始对话片段**：<dialog>"${sanitizeForMarkdown(entry.dialog)}"</dialog>`,
    `- **提炼信息**：${sanitizeForMarkdown(entry.insight)}`,
    `- **置信度**：${entry.confidence}`,
    `- **关联标签**：${formatTags(entry.tags)}`,
  ];
  if (entry.conflict) {
    lines.push(`- <conflict>${sanitizeForMarkdown(entry.conflict)}</conflict>`);
  }
  return lines.join('\n');
}

/** 关联标签统一补 # 前缀：`#tag1` `#tag2` */
function formatTags(tags: string[]): string {
  return tags.map((tag) => `\`#${tag.replace(/^#/, '')}\``).join(' ');
}

/** 提示词 4.3 每日对话摘要全文 */
function formatSessionLog(summary: SessionSummary): string {
  const lines = [
    `# 对话摘要 · ${summary.date}`,
    '',
    '## 核心话题',
    ...summary.topics.map((topic) => `- ${topic}`),
    '',
    '## 情绪基调',
    summary.mood,
    '',
    '## 新增记忆',
    ...summary.newMemories.map((item) => `- ${item}`),
    '',
    '## 待跟进事项',
    ...summary.followUps.map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

/** 加载 session_logs/ 下最近 7 天的 .md 文件内容（按文件名倒序，最多 7 篇） */
async function loadRecentSessions(historyDir: string): Promise<string[]> {
  const sessionDir = path.join(historyDir, 'session_logs');
  let files: string[];
  try {
    files = await readdir(sessionDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const mdFiles = files
    .filter((file) => file.endsWith('.md'))
    .sort((a, b) => (a < b ? 1 : -1));
  const sessions: string[] = [];
  for (const file of mdFiles.slice(0, 7)) {
    const content = readIfExists(path.join(sessionDir, file));
    if (content !== null) sessions.push(content);
  }
  return sessions;
}

// ===== 3d：记忆压缩 / 去重 / 失效 / 上限 =====

interface ParsedEntry {
  date: string;
  entry: ArchiveEntry;
}

/** 解析归档文件为条目列表（保持文件内顺序） */
function parseArchiveFile(content: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const headerRe = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;
  const blocks: Array<{ date: string; body: string }> = [];
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  let lastDate = '';
  while ((m = headerRe.exec(content)) !== null) {
    if (lastDate && lastIndex < m.index) {
      blocks.push({ date: lastDate, body: content.slice(lastIndex, m.index) });
    }
    lastDate = m[1];
    lastIndex = m.index;
    headerRe.lastIndex = m.index + m[0].length;
  }
  if (lastDate) {
    blocks.push({ date: lastDate, body: content.slice(lastIndex) });
  }
  for (const block of blocks) {
    const entryRe = /### \[归档类型：([^\]]+)\]([\s\S]*?)(?=### |\n## |$)/g;
    let em: RegExpExecArray | null;
    while ((em = entryRe.exec(block.body)) !== null) {
      const type = em[1] as ArchiveType;
      const text = em[2];
      const dialogMatch = /<dialog>"([\s\S]*?)"<\/dialog>/.exec(text);
      const insightMatch = /提炼信息\*\*：([\s\S]*?)(?:\n|$)/.exec(text);
      const confMatch = /置信度\*\*：(高|中|低)/.exec(text);
      const tags: string[] = [];
      const tagRe = /`#([^`\s]+)`/g;
      let tm: RegExpExecArray | null;
      while ((tm = tagRe.exec(text)) !== null) tags.push('#' + tm[1]);
      if (!insightMatch || !dialogMatch) continue;
      out.push({
        date: block.date,
        entry: {
          type,
          dialog: dialogMatch[1],
          insight: (insightMatch[1] ?? '').trim(),
          confidence: (confMatch?.[1] as Confidence) ?? '低',
          tags,
        },
      });
    }
  }
  return out;
}

/** 取条目的主标签：跳过元标签（个人/模式/身份/日期），无则返回 tags[0] */
function primaryTag(tags: string[]): string | null {
  const meta = new Set(['#个人', '#模式', '#身份', '#重要日期']);
  for (const tag of tags) {
    if (!meta.has(tag)) return tag;
  }
  return tags.length > 0 ? tags[0] : null;
}

/** 按标签折叠：同一主标签条目 >5 条时合并为 1 条精炼条目（3d） */
function mergeByTag(items: ParsedEntry[]): ParsedEntry[] {
  const counts = new Map<string, number>();
  for (const it of items) {
    const tag = primaryTag(it.entry.tags);
    if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  const toMerge = new Set<string>();
  counts.forEach((n, tag) => {
    if (n > 5) toMerge.add(tag);
  });
  if (toMerge.size === 0) return items;
  const grouped = new Map<string, ParsedEntry[]>();
  const keep: ParsedEntry[] = [];
  for (const it of items) {
    const tag = primaryTag(it.entry.tags);
    if (tag && toMerge.has(tag)) {
      const arr = grouped.get(tag) ?? [];
      arr.push(it);
      grouped.set(tag, arr);
    } else {
      keep.push(it);
    }
  }
  const merged: ParsedEntry[] = [];
  for (const [tag, arr] of grouped) {
    const days = new Set(arr.map((a) => a.date)).size;
    merged.push({
      date: arr[arr.length - 1].date,
      entry: {
        type: '偏好',
        dialog: '（已合并多条同类记忆）',
        insight:
          '用户多次提及「' + tag.replace(/^#/, '') + '」相关话题（共 ' + arr.length + ' 条，跨 ' + days + ' 天），已折叠为一条精炼记忆。',
        confidence: '中',
        tags: [tag, '#模式'],
      },
    });
  }
  // 保持时间顺序：keep 按原序，合并条目归入其对应最新日期位置（简化：追加到末尾并按日期排序）
  return [...keep, ...merged].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 重写归档文件（去重 + 衰减 + 合并 + 硬上限） */
function compactArchiveFile(filePath: string): void {
  const content = readIfExists(filePath);
  if (content === null || !content.trim()) return;
  let items = parseArchiveFile(content);
  if (items.length === 0) return;
  // 1) 跨会话去重：dialog 相同保留最新一条
  const seen = new Map<string, ParsedEntry>();
  for (const it of items) seen.set(it.entry.dialog, it);
  items = Array.from(seen.values());
  // 2) 低置信度 30 天衰减（3d）
  const cutoff = addDays(localDate(), -LOW_CONFIDENCE_TTL_DAYS);
  items = items.filter((it) => !(it.entry.confidence === '低' && it.date < cutoff));
  // 3) 按标签合并（>5 条折叠为 1 条）
  items = mergeByTag(items);
  // 4) 硬上限：保留最新 ARCHIVE_FILE_SOFT_CAP 条
  if (items.length > ARCHIVE_FILE_SOFT_CAP) {
    items = items.slice(-ARCHIVE_FILE_SOFT_CAP);
  }
  // 重写文件
  const sections = new Map<string, string[]>();
  for (const it of items) {
    const arr = sections.get(it.date) ?? [];
    arr.push(formatArchiveEntry(it.entry));
    sections.set(it.date, arr);
  }
  const parts: string[] = [];
  const sortedDates = Array.from(sections.keys()).sort((a, b) => (a < b ? -1 : 1));
  for (const date of sortedDates) {
    parts.push(`## ${date}\n\n${(sections.get(date) ?? []).join('\n')}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, parts.join('\n\n') + '\n', 'utf8');
}

/** 归档文件当前条目数（0 表示空/不存在） */
export function countArchiveEntries(content: string): number {
  const re = /### \[归档类型：/g;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) n += 1;
  return n;
}

export function createMemoryStore(rootDir?: string): MemoryStore {
  const root = path.resolve(rootDir ?? process.cwd());
  const historyDir = path.join(root, 'history');

  return {
    ensureStructure(): void {
      for (const section of Object.keys(SECTION_FILES)) {
        fs.mkdirSync(path.join(historyDir, section), { recursive: true });
      }
    },

    async load(): Promise<LoadedMemories> {
      const profile: Record<string, string> = {};
      for (const file of SECTION_FILES.profile) {
        const content = readIfExists(path.join(historyDir, 'profile', file));
        if (content !== null) profile[file] = content;
      }
      const importantDates = readIfExists(
        path.join(historyDir, 'timeline', 'important_dates.md'),
      );
      const patterns = readIfExists(path.join(historyDir, 'insights', 'patterns.md'));
      const journal = readIfExists(path.join(historyDir, 'experiences', 'journal.md'));
      const recentSessions = await loadRecentSessions(historyDir);
      return { profile, importantDates, patterns, journal, recentSessions };
    },

    appendArchive(section: MemorySection, entry: ArchiveEntry): void {
      if (!ARCHIVE_SECTIONS.has(section)) {
        throw new Error(`无效的记忆分区：${section}（session_logs 只能通过 appendSessionLog 写入）`);
      }
      const target = ARCHIVE_TARGETS[entry.type];
      if (!target) {
        throw new Error(`未知的归档类型：${String(entry.type)}`);
      }
      const filePath = path.join(historyDir, target);
      const date = localDate();
      let content = readIfExists(filePath) ?? '';
      // 3d：写入前检查条目数，达到软上限先压缩，保证硬上限（≤100）
      if (countArchiveEntries(content) >= ARCHIVE_FILE_SOFT_CAP) {
        compactArchiveFile(filePath);
        content = readIfExists(filePath) ?? '';
      }
      const entryBlock = formatArchiveEntry(entry);
      const base = ensureTrailingBlank(content);
      const block =
        lastDateHeader(content) === date
          ? `${entryBlock}\n`
          : `## ${date}\n\n${entryBlock}\n`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, base + block, 'utf8');
    },

    appendSessionLog(summary: SessionSummary): void {
      if (!DATE_RE.test(summary.date)) {
        throw new Error(`无效的日期格式：${summary.date}，应为 YYYY-MM-DD`);
      }
      const filePath = path.join(historyDir, 'session_logs', `${summary.date}.md`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${formatSessionLog(summary)}\n`, 'utf8');
    },
  };
}

/** 导出供 3d 验收使用的压缩入口（独立于 store 实例） */
export function compactMemoryFile(filePath: string): void {
  compactArchiveFile(filePath);
}