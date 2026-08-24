/**
 * 内置工具白名单（第 5 期批次二 · KS-17/KS-18/KS-22）
 *
 * 首批 8 工具：
 * - read：list_directory / read_file / read_vault_note / search_vault / search_memory
 * - write：append_memory / edit_present
 * - danger：run_shell（默认不注册，THATPERSON_ENABLE_SHELL=true 才注册，且仍需用户确认）
 *
 * 全部 node:fs / node:path / node:child_process 原生实现，零第三方依赖；
 * 写入一律经过 sanitize 与路径白名单，search_memory 自实现，不依赖 chat.ts（避免循环依赖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { assertPathAllowed, envInt } from './guards';
import { registerTool } from './registry';
import type { ToolContext, ToolDef, ToolResult } from './types';

// ===== 通用小工具 =====

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地时区 YYYY-MM-DD */
function localDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 读取文件，不存在返回 null */
function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** 清洗写盘字段：转义 XML/Markdown 控制字符、折叠换行（防标签闭合与伪造条目） */
function sanitizeForMarkdown(text: string): string {
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 保证内容以空行结尾（空串原样返回），用于追加时对齐格式 */
function ensureTrailingBlank(content: string): string {
  if (content === '') return '';
  if (content.endsWith('\n\n')) return content;
  if (content.endsWith('\n')) return `${content}\n`;
  return `${content}\n\n`;
}

/** 取文件末尾最后一个 `## YYYY-MM-DD` 日期标题；没有则返回 null */
function lastDateHeader(content: string): string | null {
  const headerRe = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(content)) !== null) last = m[1];
  return last;
}

/** 扫描目录时跳过的目录（避免扫描依赖/版本库/记忆目录，控制体积） */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-test']);
/** 单次扫描文件数上限（防递归炸弹；THATPERSON_MAX_SCAN_FILES 可调，默认 2000） */
const MAX_SCAN_FILES = envInt('THATPERSON_MAX_SCAN_FILES', 2000);
/** 读取/搜索跳过超大文件（THATPERSON_MAX_FILE_MB 可调，默认 50MB） */
const MAX_SEARCH_FILE_SIZE = envInt('THATPERSON_MAX_FILE_MB', 50) * 1024 * 1024;
/** 递归深度上限（THATPERSON_MAX_SCAN_DEPTH 可调，默认 16） */
const MAX_DEPTH = envInt('THATPERSON_MAX_SCAN_DEPTH', 16);

/** 递归收集 .md 文件（不跟随符号链接目录，天然防符号链接逃逸） */
function collectMdFiles(root: string, out: string[], depth: number): void {
  if (depth > MAX_DEPTH || out.length >= MAX_SCAN_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES) break;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectMdFiles(full, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
}

/** 从多个根收集 .md 文件（去重；skipMemoryDirs 时跳过 .thatperson 与 history 目录） */
function collectMdFilesFromRoots(roots: string[], skipMemoryDirs: boolean): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root) continue;
    const safe = assertPathAllowed(root, roots);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    const local: string[] = [];
    collectMdFiles(safe, local, 0);
    for (const file of local) {
      if (skipMemoryDirs) {
        const parts = file.split(path.sep);
        if (parts.includes('.thatperson') || parts.includes('history')) continue;
      }
      if (!files.includes(file)) files.push(file);
    }
  }
  return files;
}

/** 按行搜索关键词，返回 `path:行号: 内容` 命中列表（≤max 条） */
function searchLinesInFiles(files: string[], keyword: string, max: number): string[] {
  const hits: string[] = [];
  for (const file of files) {
    if (hits.length >= max) break;
    let stat: fs.Stats;
    let content: string;
    try {
      stat = fs.statSync(file);
      if (stat.size > MAX_SEARCH_FILE_SIZE) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (hits.length >= max) break;
      const line = lines[i].trim();
      if (line && line.includes(keyword)) {
        hits.push(`${file}:${i + 1}: ${line.slice(0, 200)}`);
      }
    }
  }
  return hits;
}

/** 归一化笔记日期：2026-07-31 / 2026-7-31 / 2026年7月31日 → 2026-07-31 */
function normalizeNoteDate(input: string): string | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(input);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  return null;
}

/** 2026-07-31 → 2026年7月31日（文件名兜底匹配） */
function toChineseDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

/** 在根目录内按日期找笔记（文件名含 YYYY-MM-DD 或 中文日期） */
function findNoteByDate(roots: string[], date: string): string | null {
  const files = collectMdFilesFromRoots(roots, true);
  for (const file of files) {
    if (path.basename(file, '.md').includes(date)) return file;
  }
  const alt = toChineseDate(date);
  for (const file of files) {
    if (path.basename(file, '.md').includes(alt)) return file;
  }
  return null;
}

// ===== read 工具 =====

const listDirectoryDef: ToolDef = {
  name: 'list_directory',
  description: '列出指定目录（默认当前工作目录）下的子项名称与类型，最多 50 项。仅读操作，不得越出允许目录。',
  params: [{ name: 'dir', type: 'string', required: false, description: '要列出的目录，默认当前工作目录' }],
  policy: 'read',
  handler: (args: Record<string, unknown>, ctx: ToolContext): ToolResult => {
    const dir = typeof args.dir === 'string' && args.dir.trim() ? args.dir : ctx.cwd;
    const safe = assertPathAllowed(dir, ctx.allowedRoots);
    if (!safe) return { ok: false, error: 'path-not-allowed' };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(safe);
    } catch {
      return { ok: false, error: 'path-not-found' };
    }
    if (!stat.isDirectory()) return { ok: false, error: 'not-a-directory' };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(safe, { withFileTypes: true }).slice(0, 50);
    } catch (err) {
      return { ok: false, error: `list-failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { ok: true, content: lines.length ? lines.join('\n') : '（空目录）' };
  },
};

const readFileDef: ToolDef = {
  name: 'read_file',
  description: '读取指定文件内容（UTF-8），路径必须在允许目录内，超过 2MB 拒绝。仅读操作。',
  params: [{ name: 'path', type: 'string', required: true, description: '文件路径（绝对或相对）' }],
  policy: 'read',
  handler: (args: Record<string, unknown>, ctx: ToolContext): ToolResult => {
    const raw = String(args.path);
    const safe = assertPathAllowed(raw, ctx.allowedRoots);
    if (!safe) return { ok: false, error: 'path-not-allowed' };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(safe);
    } catch {
      return { ok: false, error: 'file-not-found' };
    }
    if (!stat.isFile()) return { ok: false, error: 'not-a-file' };
    if (stat.size > MAX_SEARCH_FILE_SIZE) return { ok: false, error: 'file-too-large' };
    const content = readIfExists(safe);
    if (content === null) return { ok: false, error: 'read-failed' };
    return { ok: true, content };
  },
};

const readVaultNoteDef: ToolDef = {
  name: 'read_vault_note',
  description: '读取知识库中的 .md 笔记：传 path 读取指定笔记，或传 date（如 2026-07-31）按日期定位笔记。仅读操作。',
  params: [
    { name: 'path', type: 'string', required: false, description: '笔记路径（.md，须在允许目录内）' },
    { name: 'date', type: 'string', required: false, description: '笔记日期 YYYY-MM-DD（或 2026年7月31日）' },
  ],
  policy: 'read',
  handler: (args: Record<string, unknown>, ctx: ToolContext): ToolResult => {
    const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
    const date = typeof args.date === 'string' ? args.date.trim() : '';
    if (rawPath && date) return { ok: false, error: 'path 与 date 只能二选一' };
    let target: string;
    if (rawPath) {
      const safe = assertPathAllowed(rawPath, ctx.allowedRoots);
      if (!safe) return { ok: false, error: 'path-not-allowed' };
      if (!safe.toLowerCase().endsWith('.md')) return { ok: false, error: 'not-a-note' };
      target = safe;
    } else if (date) {
      const norm = normalizeNoteDate(date);
      if (!norm) return { ok: false, error: 'invalid-date' };
      const found = findNoteByDate(ctx.allowedRoots, norm);
      if (!found) return { ok: false, error: `note-not-found:${norm}` };
      target = found;
    } else {
      return { ok: false, error: '需要 path 或 date 参数' };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      return { ok: false, error: 'note-not-found' };
    }
    if (!stat.isFile()) return { ok: false, error: 'not-a-note' };
    const content = readIfExists(target);
    if (content === null) return { ok: false, error: 'read-failed' };
    return { ok: true, content };
  },
};

const searchVaultDef: ToolDef = {
  name: 'search_vault',
  description: '在允许目录内递归搜索 .md 笔记中的关键词，返回最多 10 条命中（路径:行号: 内容）。仅读操作。',
  params: [{ name: 'keyword', type: 'string', required: true, description: '要搜索的关键词' }],
  policy: 'read',
  handler: (args: Record<string, unknown>, ctx: ToolContext): ToolResult => {
    const keyword = String(args.keyword).trim();
    if (!keyword) return { ok: false, error: 'keyword-empty' };
    const files = collectMdFilesFromRoots(ctx.allowedRoots, true);
    const hits = searchLinesInFiles(files, keyword, 10);
    return { ok: true, content: hits.length ? hits.join('\n') : '（无命中）' };
  },
};

const searchMemoryDef: ToolDef = {
  name: 'search_memory',
  description: '在长期记忆 history/（home 与 cwd）中递归搜索关键词，返回最多 10 条命中。仅读操作，自实现不依赖 chat.ts。',
  params: [{ name: 'keyword', type: 'string', required: true, description: '要搜索的关键词' }],
  policy: 'read',
  handler: (args: Record<string, unknown>, ctx: ToolContext): ToolResult => {
    const keyword = String(args.keyword).trim();
    if (!keyword) return { ok: false, error: 'keyword-empty' };
    const roots = [path.join(ctx.home, 'history'), path.join(ctx.cwd, 'history')].filter((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    const files = collectMdFilesFromRoots(roots, false);
    const hits = searchLinesInFiles(files, keyword, 10);
    return { ok: true, content: hits.length ? hits.join('\n') : '（无命中）' };
  },
};

// ===== write 工具 =====

/** append_memory：归档类型 → history 内固定文件（杜绝路径穿越） */
const MEMORY_TYPE_TARGETS: Record<string, { section: string; file: string }> = {
  偏好: { section: 'profile', file: 'preferences.md' },
  身份: { section: 'profile', file: 'identity.md' },
  经历: { section: 'experiences', file: 'journal.md' },
  日期: { section: 'timeline', file: 'important_dates.md' },
};

const appendMemoryDef: ToolDef = {
  name: 'append_memory',
  description: '把用户明确要求记住的信息即时写入长期记忆（home/history 对应归档文件），追加不覆盖。write 操作。',
  params: [
    { name: 'type', type: 'string', required: true, enum: ['偏好', '经历', '日期', '身份'], description: '归档类型' },
    { name: 'insight', type: 'string', required: true, description: '提炼信息（一句话概括）' },
    { name: 'dialog', type: 'string', required: false, description: '原始对话片段（可选）' },
    { name: 'confidence', type: 'string', required: false, enum: ['高', '中', '低'], description: '置信度，默认中' },
  ],
  policy: 'write',
  handler: (args: Record<string, unknown>, ctx: ToolContext): ToolResult => {
    const type = String(args.type);
    const insight = String(args.insight).trim();
    const dialog = typeof args.dialog === 'string' ? args.dialog.trim() : '';
    const confidence = typeof args.confidence === 'string' ? args.confidence : '中';
    if (!insight) return { ok: false, error: 'insight-empty' };
    const target = MEMORY_TYPE_TARGETS[type];
    if (!target) return { ok: false, error: `unknown-type:${type}` };
    const home = path.resolve(ctx.home);
    const filePath = path.join(home, 'history', target.section, target.file);
    if (!(filePath.startsWith(home + path.sep) || filePath === home)) {
      return { ok: false, error: 'path-not-allowed' };
    }
    const date = localDate();
    const entryBlock = [
      `### [归档类型：${type}]`,
      '',
      `- **原始对话片段**：<dialog>"${sanitizeForMarkdown(dialog || '（未提供原话）')}"</dialog>`,
      `- **提炼信息**：${sanitizeForMarkdown(insight)}`,
      `- **置信度**：${confidence}`,
      '- **关联标签**：（无）',
    ].join('\n');
    const existing = readIfExists(filePath) ?? '';
    const base = ensureTrailingBlank(existing);
    const block = lastDateHeader(existing) === date ? `${entryBlock}\n` : `## ${date}\n\n${entryBlock}\n`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, base + block, 'utf8');
    } catch (err) {
      return { ok: false, error: `append-failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, content: `已追加记忆（${type} → history/${target.section}/${target.file}）` };
  },
};

/** edit_present：允许编辑的 present 文件名白名单 */
const PRESENT_FILE_WHITELIST = new Set([
  'identity.md',
  'traits.md',
  'behavior.md',
  'persona.md',
  'capabilities.md',
  'output.md',
]);

const editPresentDef: ToolDef = {
  name: 'edit_present',
  description: '编辑人设文件（home/present，仅白名单文件名）：append 追加新段落，replace 用 oldValue 精确匹配既有行后替换。write 操作，冲突拒绝覆盖。',
  params: [
    { name: 'file', type: 'string', required: true, description: 'present 文件名（identity/traits/behavior/persona/capabilities/output.md）' },
    { name: 'content', type: 'string', required: true, description: '要写入的内容' },
    { name: 'mode', type: 'string', required: false, enum: ['append', 'replace'], description: '追加或替换，默认 append' },
    { name: 'oldValue', type: 'string', required: false, description: 'replace 模式下要替换的既有行（精确匹配）' },
  ],
  policy: 'write',
  handler: (args: Record<string, unknown>, ctx: ToolContext): ToolResult => {
    const file = String(args.file).trim();
    const content = String(args.content);
    const mode = typeof args.mode === 'string' ? args.mode : 'append';
    const oldValue = typeof args.oldValue === 'string' ? args.oldValue : '';
    if (!PRESENT_FILE_WHITELIST.has(file)) {
      return { ok: false, error: 'file-not-in-whitelist' };
    }
    const home = path.resolve(ctx.home);
    const filePath = path.join(home, 'present', file);
    if (!(filePath.startsWith(home + path.sep) || filePath === home)) {
      return { ok: false, error: 'path-not-allowed' };
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (mode === 'replace') {
        if (!oldValue) return { ok: false, error: 'missing-oldValue' };
        const existing = readIfExists(filePath);
        if (existing === null) return { ok: false, error: 'conflict' };
        const lines = existing.split(/\r?\n/);
        if (!lines.includes(oldValue)) return { ok: false, error: 'conflict' };
        const next = lines.map((line) => (line === oldValue ? content : line)).join('\n');
        fs.writeFileSync(filePath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
      } else {
        const existing = readIfExists(filePath) ?? '';
        const next = existing.trimEnd() ? `${existing.replace(/\s+$/, '')}\n\n${content}\n` : `${content}\n`;
        fs.writeFileSync(filePath, next, 'utf8');
      }
    } catch (err) {
      return { ok: false, error: `edit-failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, content: `已${mode === 'replace' ? '替换' : '追加'} ${file}` };
  },
};

// ===== danger 工具 =====

const runShellDef: ToolDef = {
  name: 'run_shell',
  description: '危险操作，需用户确认。在系统 Shell 中执行命令并返回标准输出（截断）。仅当 THATPERSON_ENABLE_SHELL=true 且用户逐次确认后可用，默认禁用。',
  params: [{ name: 'command', type: 'string', required: true, description: '要执行的命令' }],
  policy: 'danger',
  handler: (args: Record<string, unknown>): Promise<ToolResult> => {
    const command = String(args.command);
    const isWin = process.platform === 'win32';
    const shell = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
    return new Promise<ToolResult>((resolve) => {
      execFile(
        shell,
        shellArgs,
        { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = String(stderr || err.message || '').slice(0, 500);
            return resolve({ ok: false, error: `shell-exec-failed: ${detail}` });
          }
          resolve({ ok: true, content: String(stdout ?? '') });
        },
      );
    });
  },
};

/** 首批工具定义（run_shell 不在其中，单独按环境变量门控注册） */
const BUILTIN_DEFS: ToolDef[] = [
  listDirectoryDef,
  readFileDef,
  readVaultNoteDef,
  searchVaultDef,
  searchMemoryDef,
  appendMemoryDef,
  editPresentDef,
];

/**
 * 注册全部内置工具并返回已注册工具名列表。
 * run_shell 默认不注册（KS-17）：仅当 process.env.THATPERSON_ENABLE_SHELL === 'true' 时注册；
 * 即使注册，executor 在 dangerAllowed=false（ReAct 循环）下仍返回 danger-disabled（双门控）。
 */
export function registerBuiltins(): string[] {
  const names: string[] = [];
  for (const def of BUILTIN_DEFS) {
    registerTool(def);
    names.push(def.name);
  }
  if (process.env.THATPERSON_ENABLE_SHELL === 'true') {
    registerTool(runShellDef);
    names.push(runShellDef.name);
  }
  return names;
}
