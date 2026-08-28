/**
 * 会话记录与恢复（第 6 期 · KS-42~KS-44；批次三 D-3 预研）
 *
 * 预研范围（批次二 PASS 前）：只提供接口签名 + 纯函数实现，编译通过；
 * /list /load /title 接线进 cli.ts 留到批次二 PASS 后，本期不注册、不改 loop/chat。
 *
 * 契约对齐：
 * - 快照复用 history/sessions/session_<时间戳>.md（Markdown 人可读），frontmatter 规范：
 *   id / title / created_at / updated_at / summary；
 * - index.json 只做目录（{ version, sessions: [{ id, title, created_at, file }] }），
 *   可重建非唯一事实——快照文件才是唯一事实；
 * - foldToRecovered 对齐 cli.ts 的 HISTORY_LIMIT=8（最近 4 轮完整）与
 *   chat.ts 的 SUMMARY_CHAR_LIMIT=6000（超限二次折叠）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from './chat';

/** 折叠阈值：保留最近 N 条消息完整（4 轮 = 8 条，对齐 cli.ts HISTORY_LIMIT） */
export const DEFAULT_HISTORY_LIMIT = 8;
/** summary 字符上限（对齐 chat.ts SUMMARY_CHAR_LIMIT 默认 6000） */
export const DEFAULT_SUMMARY_CHAR_LIMIT = 6000;

/** 恢复会话契约：history + summary 直接作为下一次 runAgentLoop({ history, summary, userPrompt }) 的输入 */
export interface RecoveredSession {
  history: ChatMessage[];
  summary: string;
}

/** 会话目录项（index.json 的一行 / rebuildIndex 的输出） */
export interface SessionMeta {
  id: string;
  title: string;
  created_at: string;
  file: string;
}

/** index.json 结构：只做目录、不存消息 */
interface SessionIndex {
  version: number;
  sessions: SessionMeta[];
}

/** 快照文件名：兼容规范 session_<时间戳>.md 与既有 /save 的 session-<时间戳>.md */
const SESSION_FILE_RE = /^session[_\-].*\.md$/;
/** frontmatter 块（对齐 skill.ts 的 FRONTMATTER_RE 约定） */
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

// ===== 纯函数：解析 =====

/** 去掉 frontmatter（---...---）后的正文；无 frontmatter 时原样返回 */
function stripFrontmatter(md: string): string {
  const m = FRONTMATTER_RE.exec(md);
  return m ? md.slice(m[0].length) : md;
}

/**
 * 解析快照 .md → 消息列表。
 * - 新格式：按 `## 用户` / `## ThatPerson` 二级标题分块；
 * - 旧格式（兼容 /save）：`**用户**：` / `**ThatPerson**：` 行；
 * - frontmatter（---...---）一律跳过。
 */
export function parseSnapshot(md: string): ChatMessage[] {
  const body = stripFrontmatter(md);
  const sectionRe = /^##\s+(用户|ThatPerson)\s*$/gm;
  const matches = [...body.matchAll(sectionRe)];
  if (matches.length > 0) {
    const out: ChatMessage[] = [];
    for (let i = 0; i < matches.length; i += 1) {
      const role = matches[i][1] === '用户' ? 'user' : 'assistant';
      const start = matches[i].index + matches[i][0].length;
      const end = matches[i + 1] ? matches[i + 1].index : body.length;
      const content = body.slice(start, end).trim();
      if (content) out.push({ role, content });
    }
    return out;
  }
  // 旧格式：逐行匹配 **用户**：/**ThatPerson**：
  const lineRe = /^\*\*(用户|ThatPerson)\*\*[：:]\s*(.*)$/;
  const out: ChatMessage[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = lineRe.exec(line);
    if (m) out.push({ role: m[1] === '用户' ? 'user' : 'assistant', content: m[2] });
  }
  return out;
}

// ===== 纯函数：折叠 =====

/** 把更早的 messages 按轮折成摘要（每轮 `用户：…\nThatPerson：…`，轮间空行分隔） */
function foldRounds(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (let i = 0; i < messages.length; i += 2) {
    const u = messages[i];
    const a = messages[i + 1];
    if (!u) continue;
    const lines: string[] = [];
    if (u.role === 'user') lines.push(`用户：${u.content}`);
    else lines.push(`ThatPerson：${u.content}`);
    if (a && a.content) lines.push(`ThatPerson：${a.content}`);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * 折叠为 RecoveredSession：保留最近 historyLimit 条消息完整（默认 8 = 4 轮），
 * 更早的折进 summary；summary 超 summaryCharLimit（默认 6000）时二次折叠截断
 * （对齐 chat.ts foldSummary：保留尾部 + 折叠标记）。
 */
export function foldToRecovered(
  messages: ChatMessage[],
  opts: { historyLimit?: number; summaryCharLimit?: number } = {},
): RecoveredSession {
  const historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const summaryCharLimit = opts.summaryCharLimit ?? DEFAULT_SUMMARY_CHAR_LIMIT;
  if (messages.length <= historyLimit) {
    return { history: [...messages], summary: '' };
  }
  const history = messages.slice(-historyLimit);
  const older = messages.slice(0, messages.length - historyLimit);
  let summary = foldRounds(older);
  if (summary.length > summaryCharLimit) {
    const marker = '（早期对话摘要已折叠，仅保留最近部分）';
    const keep = Math.max(0, summaryCharLimit - marker.length);
    summary = marker + summary.slice(-keep);
  }
  return { history, summary };
}

// ===== 文件层：索引 =====

/** 读 index.json；缺失 / 损坏 / 结构非法一律返回 null（触发重建） */
function readIndex(indexPath: string): SessionIndex | null {
  if (!fs.existsSync(indexPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Partial<SessionIndex>;
    if (!Array.isArray(raw.sessions)) return null;
    const sessions = raw.sessions.filter(
      (s): s is SessionMeta =>
        !!s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.file === 'string',
    );
    if (sessions.length !== raw.sessions.length) return null;
    return { version: raw.version ?? 1, sessions };
  } catch {
    return null;
  }
}

function writeIndex(indexPath: string, sessions: SessionMeta[]): void {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const index: SessionIndex = { version: 1, sessions };
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

/** 解析 frontmatter 的 key: value 行（轻量 YAML 子集） */
function parseFrontmatter(md: string): Record<string, string> {
  const m = FRONTMATTER_RE.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/** 由文件名时间戳推断 created_at（YYYYMMDD_HHmmss → YYYY-MM-DD HH:mm:ss）；无则用 mtime */
function inferCreatedAt(file: string, mtime: Date): string {
  const m = /(\d{8})_(\d{6})/.exec(file);
  if (m) {
    const d = m[1];
    const t = m[2];
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
  }
  return mtime.toISOString();
}

/**
 * 全量扫描 history/sessions/ 下的 session_*.md 重建索引：
 * 读 frontmatter 的 id / title / created_at，缺失时以文件名 / mtime 兜底；
 * 返回按 created_at 倒序（新在前）。
 */
export function rebuildIndex(historyDir: string): SessionMeta[] {
  const sessionsDir = path.join(historyDir, 'sessions');
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => SESSION_FILE_RE.test(f));
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const file of files) {
    const full = path.join(sessionsDir, file);
    let md = '';
    try {
      md = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(md);
    const stat = fs.statSync(full);
    metas.push({
      id: fm.id || file.replace(/\.md$/, ''),
      title: fm.title || '未命名会话',
      created_at: fm.created_at || inferCreatedAt(file, stat.mtime),
      file,
    });
  }
  metas.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return metas;
}

/**
 * 会话列表：读 history/sessions/index.json；
 * 缺失 / 损坏则全量扫描 session_*.md 重建并回写（索引可重建，快照才是唯一事实）。
 */
export function listSessions(historyDir: string): SessionMeta[] {
  const indexPath = path.join(historyDir, 'sessions', 'index.json');
  const cached = readIndex(indexPath);
  if (cached) return cached.sessions;
  const rebuilt = rebuildIndex(historyDir);
  writeIndex(indexPath, rebuilt);
  return rebuilt;
}

/**
 * 登记 / 更新快照元数据到 index.json（/save 写入快照后调用）：
 * - 索引缺失 → 先全量扫描重建（快照文件才是唯一事实），再 upsert；
 * - 已存在（按 id 或 file 匹配）→ 原位更新，不重复；
 * - 写回后按 created_at 倒序（新在前），与 rebuildIndex 排序一致。
 */
export function upsertSessionMeta(historyDir: string, meta: SessionMeta): void {
  const indexPath = path.join(historyDir, 'sessions', 'index.json');
  const index = readIndex(indexPath);
  const base = index ? [...index.sessions] : rebuildIndex(historyDir);
  const existing = base.find((s) => s.id === meta.id || s.file === meta.file);
  let next: SessionMeta[];
  if (existing) {
    existing.title = meta.title;
    existing.created_at = meta.created_at;
    existing.file = meta.file;
    next = base;
  } else {
    next = [...base, meta];
  }
  next.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  writeIndex(indexPath, next);
}

// ===== 文件层：加载 / 标题 =====

/** 由 id 定位快照文件：优先索引 → 文件名 → frontmatter id 扫描；找不到返回 null */
function resolveSessionFile(id: string, historyDir: string): string | null {
  // 防御：id 只允许是文件名/索引 id，拒绝路径穿越（/load 参数后续来自用户输入）
  if (!id || id.includes('/') || id.includes(String.fromCharCode(92)) || id.includes('..')) return null;
  const sessionsDir = path.join(historyDir, 'sessions');
  // 1) 直接按文件名（id 本身就是文件名/文件名去掉 .md）
  for (const candidate of [id, `${id}.md`]) {
    const p = path.join(sessionsDir, candidate);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  // 2) 索引内按 id 匹配 file
  const index = readIndex(path.join(historyDir, 'sessions', 'index.json'));
  if (index) {
    const hit = index.sessions.find((s) => s.id === id || s.file === id || s.file === `${id}.md`);
    if (hit) {
      const p = path.join(sessionsDir, hit.file);
      if (fs.existsSync(p)) return p;
    }
  }
  // 3) 全量扫描按 frontmatter id 匹配
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => SESSION_FILE_RE.test(f));
  } catch {
    return null;
  }
  for (const file of files) {
    const p = path.join(sessionsDir, file);
    try {
      const fm = parseFrontmatter(fs.readFileSync(p, 'utf8'));
      if (fm.id === id) return p;
    } catch {
      // 单文件损坏：跳过
    }
  }
  return null;
}

/** 恢复会话：解析对应快照 .md → foldToRecovered（最近 8 条 + 更早折 summary） */
export function loadSession(id: string, historyDir: string): RecoveredSession {
  const file = resolveSessionFile(id, historyDir);
  if (!file) throw new Error(`未找到会话：${id}`);
  const md = fs.readFileSync(file, 'utf8');
  return foldToRecovered(parseSnapshot(md));
}

/** 改写快照 frontmatter 的 title（同步 updated_at），并同步 index.json */
export function titleSnapshot(id: string, title: string, historyDir: string): void {
  const file = resolveSessionFile(id, historyDir);
  if (!file) throw new Error(`未找到会话：${id}`);
  const md = fs.readFileSync(file, 'utf8');
  const fm = parseFrontmatter(md);
  const now = new Date();
  const fields: Record<string, string> = {
    id: fm.id || path.basename(file).replace(/\.md$/, ''),
    title,
    created_at: fm.created_at || inferCreatedAt(path.basename(file), now),
    updated_at: now.toISOString(),
    summary: fm.summary || '',
  };
  fs.writeFileSync(file, setFrontmatterFields(md, fields), 'utf8');

  const indexPath = path.join(historyDir, 'sessions', 'index.json');
  const index = readIndex(indexPath);
  if (index) {
    const entry = index.sessions.find((s) => s.id === fields.id || s.file === path.basename(file));
    if (entry) {
      entry.title = title;
      writeIndex(indexPath, index.sessions);
      return;
    }
  }
  // 索引缺失 / 无此条目：重建（快照文件是唯一事实）
  writeIndex(indexPath, rebuildIndex(historyDir));
}

/** 设置 frontmatter 字段：无 frontmatter 时在最前插入完整块；有则原位替换/追加 */
function setFrontmatterFields(md: string, fields: Record<string, string>): string {
  const m = FRONTMATTER_RE.exec(md);
  if (!m) {
    const block = ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n');
    return `${block}${md}`;
  }
  const lines = m[1].split(/\r?\n/);
  for (const [key, value] of Object.entries(fields)) {
    const re = new RegExp(`^${key}\\s*:`);
    const idx = lines.findIndex((line) => re.test(line.trim()));
    if (idx >= 0) lines[idx] = `${key}: ${value}`;
    else lines.push(`${key}: ${value}`);
  }
  const rest = md.slice(m[0].length);
  return `---\n${lines.join('\n')}\n---\n${rest.startsWith('\n') ? rest : `\n${rest}`}`;
}
