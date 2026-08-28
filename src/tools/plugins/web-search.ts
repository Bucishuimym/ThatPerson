/**
 * web_search 插件工具（第 6 期批次一 · 能力底座口径；第 6 期批次二 · KS-34 标注 L0）
 *
 * 在 ctx.allowedRoots 内递归扫描 .md 文件（跳过 .git/node_modules/dist），
 * 按行搜索关键词，返回 `path:行号: 内容` 命中列表（≤20 条，truncateResult 截断）。
 * 仅读操作；默认不注册，由 builtin.ts 用 THATPERSON_ENABLE_WEB_SEARCH === 'true' 门控。
 * 实现对齐 builtin.ts 的 search_vault（node:fs / node:path 原生，零第三方依赖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertPathAllowed, envInt, truncateResult } from '../guards';
import type { ToolContext, ToolDef, ToolHandlerResult } from '../types';

/** 扫描目录时跳过的目录 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
/** 单次扫描文件数上限（THATPERSON_MAX_SCAN_FILES 可调，默认 2000） */
const MAX_SCAN_FILES = envInt('THATPERSON_MAX_SCAN_FILES', 2000);
/** 搜索跳过超大文件（THATPERSON_MAX_FILE_MB 可调，默认 50MB） */
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
        hits.push(`${file}:${i + 1}: ${line}`);
      }
    }
  }
  return hits;
}

export const webSearchDef: ToolDef = {
  name: 'web_search',
  description: '在允许目录内递归搜索 .md 笔记中的关键词，返回最多 20 条命中（路径:行号: 内容）。仅读操作；默认不注册，需 THATPERSON_ENABLE_WEB_SEARCH=true。',
  params: [{ name: 'keyword', type: 'string', required: true, description: '要搜索的关键词' }],
  policy: 'read',
  riskLevel: 'L0',
  handler: (args: Record<string, unknown>, ctx: ToolContext): ToolHandlerResult => {
    const keyword = String(args.keyword).trim();
    if (!keyword) return { ok: false, error: 'keyword-empty' };
    const files: string[] = [];
    const seen = new Set<string>();
    for (const root of ctx.allowedRoots) {
      if (!root) continue;
      const safe = assertPathAllowed(root, ctx.allowedRoots);
      if (!safe || seen.has(safe)) continue;
      seen.add(safe);
      collectMdFiles(safe, files, 0);
    }
    const hits = searchLinesInFiles(files, keyword, 20);
    const content = hits.length ? hits.join('\n') : '（无命中）';
    return { ok: true, content: truncateResult(content) };
  },
};
