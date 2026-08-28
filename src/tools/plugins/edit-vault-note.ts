/**
 * edit_vault_note 插件工具（第 6 期批次一 · 能力底座口径；第 6 期批次二 · KS-34 标注 L2 / 红线无解锁路径）
 *
 * 编辑 .md 笔记（write）：append 追加 / replace 精确匹配行替换 / frontmatter 更新键值。
 * 仅允许 .md 扩展名；敏感文件名（.env* / API-key* / *.key / .gitignore）红线拒绝；
 * 路径须在允许目录内；写前 content 经 sanitizeForMarkdown（复制 builtin.ts 实现）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertPathAllowed } from '../guards';
import type { ToolContext, ToolDef, ToolHandlerResult } from '../types';

/** 读取文件，不存在返回 null */
function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** 清洗写盘字段：转义 < >、折叠换行（复制 builtin.ts 的实现） */
function sanitizeForMarkdown(text: string): string {
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 敏感文件名红线：.env* / API-key* / *.key / .gitignore 一律拒绝编辑 */
function isRedlinedName(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.') || lower.startsWith('.env-')) return true;
  if (lower.includes('api-key')) return true;
  if (lower.endsWith('.key')) return true;
  if (lower === '.gitignore') return true;
  return false;
}

/** 解析文件头部 frontmatter 块：`---\n...\n---`；没有则返回 null */
interface FmParse {
  keys: string[];
  values: Record<string, string>;
  body: string;
}

function parseFrontmatter(content: string): FmParse | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!m) return null;
  const keys: string[] = [];
  const values: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    if (!(key in values)) keys.push(key);
    values[key] = line.slice(idx + 1).trim();
  }
  return { keys, values, body: content.slice(m[0].length) };
}

/** 渲染 frontmatter：保留既有键顺序，body 原样保留 */
function renderFrontmatter(fm: FmParse): string {
  const lines = fm.keys.map((k) => `${k}: ${fm.values[k]}`);
  return `---\n${lines.join('\n')}\n---\n${fm.body}`;
}

export const editVaultNoteDef: ToolDef = {
  name: 'edit_vault_note',
  description: '编辑 .md 笔记：append 追加、replace 用 oldValue 精确匹配行后替换、frontmatter 更新/追加键值（保留其他键）。敏感文件（.env/API-key/*.key/.gitignore）拒绝。write 操作。',
  params: [
    { name: 'file', type: 'string', required: true, description: '笔记路径（.md，须在允许目录内）' },
    { name: 'content', type: 'string', required: true, description: '要写入的内容' },
    { name: 'mode', type: 'string', required: false, enum: ['append', 'replace', 'frontmatter'], description: '追加/替换/frontmatter，默认 append' },
    { name: 'oldValue', type: 'string', required: false, description: 'replace 模式下要替换的既有行（精确匹配）' },
  ],
  policy: 'write',
  riskLevel: 'L2',
  handler: (args: Record<string, unknown>, ctx: ToolContext): ToolHandlerResult => {
    const fileRaw = String(args.file).trim();
    const contentRaw = String(args.content);
    const mode = typeof args.mode === 'string' && args.mode ? args.mode : 'append';
    const oldValue = typeof args.oldValue === 'string' ? args.oldValue : '';

    // 红线优先于扩展名判定（KS-35：.env / secret.key 等非 .md 敏感文件同样 redline-denied）
    const basename = path.basename(fileRaw);
    if (isRedlinedName(basename)) {
      return { ok: false, error: `redline-denied: 敏感文件不可编辑：${basename}` };
    }
    if (!fileRaw.toLowerCase().endsWith('.md')) {
      return { ok: false, error: 'not-a-note' };
    }
    const safe = assertPathAllowed(fileRaw, ctx.allowedRoots);
    if (!safe) return { ok: false, error: 'path-not-allowed' };

    try {
      if (mode === 'replace') {
        if (!oldValue) return { ok: false, error: 'missing-oldValue' };
        const existing = readIfExists(safe);
        if (existing === null) return { ok: false, error: 'conflict: 文件不存在' };
        const lines = existing.split(/\r?\n/);
        if (!lines.includes(oldValue)) return { ok: false, error: 'conflict' };
        const sanitized = sanitizeForMarkdown(contentRaw);
        const next = lines.map((line) => (line === oldValue ? sanitized : line)).join('\n');
        fs.writeFileSync(safe, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
      } else if (mode === 'frontmatter') {
        const existing = readIfExists(safe) ?? '';
        const sanitizedLines = contentRaw
          .split(/\r?\n/)
          .map((line) => sanitizeForMarkdown(line))
          .filter((line) => line.length > 0);
        const fm: FmParse = parseFrontmatter(existing) ?? { keys: [], values: {}, body: existing };
        for (const line of sanitizedLines) {
          const idx = line.indexOf(':');
          if (idx <= 0) continue;
          const key = line.slice(0, idx).trim();
          const value = line.slice(idx + 1).trim();
          if (!key) continue;
          if (!(key in fm.values)) fm.keys.push(key);
          fm.values[key] = value;
        }
        const next = renderFrontmatter(fm);
        fs.writeFileSync(safe, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
      } else {
        // append（默认）：确保换行，文件不存在则创建
        const sanitized = sanitizeForMarkdown(contentRaw);
        const existing = readIfExists(safe) ?? '';
        let next = existing;
        if (next && !next.endsWith('\n')) next += '\n';
        next += `${sanitized}\n`;
        fs.writeFileSync(safe, next, 'utf8');
      }
    } catch (err) {
      return { ok: false, error: `edit-failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const verb = mode === 'replace' ? '替换' : mode === 'frontmatter' ? '更新 frontmatter' : '追加';
    return { ok: true, content: `已${verb} ${fileRaw}` };
  },
};
