/**
 * web_search / vault_search 插件工具（第 7 期批次一 · KS-7.9 / KS-7.12 / DD-7.5 / DD-7.4）
 *
 * - vault_search（原 web_search 本地 .md 搜索改名让位，KS-7.12）：在 ctx.allowedRoots 内递归扫描
 *   .md 文件（跳过 .git/node_modules/dist），按行搜索关键词，返回 `path:行号: 内容` 命中列表
 *   （≤20 条，truncateResult 截断）。read/L0，沿用原门控 THATPERSON_ENABLE_WEB_SEARCH（DD-7.5），
 *   语义/截断与旧实现等值。
 * - web_search（真上网搜索，KS-7.9）：DuckDuckGo HTML 端点（https://html.duckduckgo.com/html/?q=）
 *   为唯一默认 provider（SEC-6 本期新增唯一联网端点；白名单约束端点，任意域名不出本插件）；
 *   node 全局 fetch 零依赖；正则解析结果（title/url/snippet ≤5 条，result__a href 的 uddg 参数解码）；
 *   解析失败/网络失败 → 结构化错误（不假成功）；UA 头必备；搜索结果同样走缓存。
 *   read/L0，仅 THATPERSON_ENABLE_WEB==='true' 注册。
 *
 * HTTP 传输一律经 web-fetch 的 __getWebFetchImpl 共享注入点（mock 基建①只包这一处）；
 * 缓存读写复用 web-fetch 的 history/cache/web/sha256(key).json 实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertPathAllowed, envInt, truncateResult } from '../guards';
import { __getWebFetchImpl, fetchWithTimeout, readWebCache, webTimeoutMs, WEB_UA, writeWebCache } from './web-fetch';
import type { ToolContext, ToolDef, ToolHandlerResult } from '../types';

// ===== vault_search（原 web_search 本地实现，语义等值）=====

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

/** vault_search 定义（原 web_search 本地 .md 搜索，KS-7.12 改名让位；门控/语义不变） */
export const vaultSearchDef: ToolDef = {
  name: 'vault_search',
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

// ===== web_search（真 DDG 搜索，KS-7.9）=====

/** 唯一默认 provider 端点（SEC-6：本期新增唯一联网端点，白名单约束仅此一处） */
const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/?q=';
/** 返回结果条数上限（KS-7.9：≤5 条） */
const MAX_RESULTS = 5;

/** 去 HTML 标签 + 折叠空白（DDG 片段净化用） */
function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** DDG href 归一化：// 协议相对补 https；uddg 包装参数解码出真实目标 URL */
function normalizeResultUrl(href: string): string | null {
  let url = href.trim();
  if (!url) return null;
  if (url.startsWith('//')) url = `https:${url}`;
  const uddg = /[?&]uddg=([^&]+)/.exec(url);
  if (uddg) {
    try {
      url = decodeURIComponent(uddg[1]);
    } catch {
      return null;
    }
  }
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

/** 一条搜索结果 */
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 正则解析 DDG HTML 结果页（result__a 标题/链接 + result__snippet 摘要，按出现顺序配对） */
function parseDdgResults(html: string): SearchResult[] {
  const titles: Array<{ title: string; url: string }> = [];
  const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(linkRe)) {
    const attrs = m[1] ?? '';
    if (!/class\s*=\s*["'][^"']*result__a/i.test(attrs)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '';
    const url = normalizeResultUrl(href);
    if (!url) continue;
    const title = stripTags(m[2] ?? '');
    if (!title) continue;
    titles.push({ title, url });
  }
  const snippets: string[] = [];
  const snippetRe = /<a\b[^>]*class\s*=\s*["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(snippetRe)) {
    snippets.push(stripTags(m[1] ?? ''));
  }
  return titles.map((t, i) => ({ ...t, snippet: snippets[i] ?? '' }));
}

/** 真 web_search 定义（DDG HTML 端点，KS-7.9；THATPERSON_ENABLE_WEB==='true' 才注册） */
export const webSearchDef: ToolDef = {
  name: 'web_search',
  description: '用 DuckDuckGo 搜索公网并返回最多 5 条结果（标题｜链接｜摘要），解析失败/断网时如实报错。仅读操作；默认不注册，需 THATPERSON_ENABLE_WEB=true。',
  params: [{ name: 'keyword', type: 'string', required: true, description: '要搜索的关键词' }],
  policy: 'read',
  riskLevel: 'L0',
  handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const keyword = String(args.keyword).trim();
    if (!keyword) return { ok: false, error: 'keyword-empty' };
    const url = `${DDG_ENDPOINT}${encodeURIComponent(keyword)}`;

    // ① 缓存命中零传输（搜索结果同样走缓存，key = 端点+query）
    const cached = readWebCache(ctx.home, url);
    if (typeof cached === 'string' && cached) return { ok: true, content: cached };

    // ② 经共享注入点传输（mock 基建①只包这一处；端点固定 html.duckduckgo.com，无 SSRF 面）
    let html: string;
    try {
      const res = await fetchWithTimeout(
        __getWebFetchImpl(),
        url,
        {
          headers: {
            'User-Agent': WEB_UA,
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            Accept: 'text/html',
          },
        },
        webTimeoutMs(),
      );
      if (!res.ok) return { ok: false, error: `web-search-failed: 搜索端点 HTTP ${res.status}` };
      html = await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `web-search-failed: ${msg.slice(0, 200)}` };
    }

    // ③ 正则解析 ≤5 条；解析失败不假成功
    const results = parseDdgResults(html).slice(0, MAX_RESULTS);
    if (results.length === 0) {
      return { ok: false, error: 'web-search-failed: 未能从搜索结果页解析出结果' };
    }
    const content = truncateResult(
      results.map((r, i) => `${i + 1}. ${r.title}｜${r.url}${r.snippet ? `｜${r.snippet}` : ''}`).join('\n'),
    );
    // ④ 仅成功结果落缓存
    writeWebCache(ctx.home, url, content);
    return { ok: true, content };
  },
};
