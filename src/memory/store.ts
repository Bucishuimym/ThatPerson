/**
 * 记忆存储实现（依据《关于ThatGirl-Agent项目第一版提示词》v3.0）
 * 提示词 2.1 存储结构 / 2.2 读取流程 / 4.2 归档格式 / 4.3 每日摘要格式
 * 接口契约见 src/memory/types.ts（只实现，不修改契约）
 */
import fs from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  ArchiveEntry,
  ArchiveType,
  LoadedMemories,
  MemorySection,
  MemoryStore,
  SECTION_FILES,
  SessionSummary,
} from './types';

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

export function createMemoryStore(rootDir?: string): MemoryStore {
  const root = path.resolve(rootDir ?? process.cwd());
  const historyDir = path.join(root, 'history');

  return {
    ensureStructure(): void {
      for (const section of Object.keys(SECTION_FILES) as MemorySection[]) {
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
      const recentSessions = await loadRecentSessions(historyDir);
      return { profile, importantDates, patterns, recentSessions };
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
      const content = readIfExists(filePath) ?? '';
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