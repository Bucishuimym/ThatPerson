/**
 * mock 基建四件（第 7 期批次一 · D-4 测试组规范；KS-7.13 / KS-7.23）
 *
 * ① HTTP 桩：包装 web 插件的 __setWebFetchImpl（web_fetch / web_search 共享注入点），
 *    注入桩响应 + fetch 调用计数器（缓存零网络断言依赖它）；
 * ② 确认桩：包装 write-gate 的 setWriteConfirmHandler，可注入 confirm=true/false 与调用记录；
 * ③ vault fixture：临时目录造「个人文件」样本（日记/小说/笔记，含中文内容与农历日期句式）；
 * ④ 审计快照读取器：读 <home>/logs/tool-*.jsonl 返回 JSON 行数组（断言 decision/count/targetDirKey 用）。
 *
 * 全部离线：桩注入后不触达任何真实网络；各 helper 返回 restore() 供 test.after 清理。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { __setWebFetchImpl } from '../src/tools/plugins/web-fetch';
import { setWriteConfirmHandler, type WritePlan } from '../src/tools/write-gate';

// ===== ① HTTP 桩（web 插件共享注入点）=====

/** 桩响应器：按 URL/init 返回合成 Response（node 22 全局 Response） */
export type WebFetchResponder = (url: string, init?: RequestInit) => Response | Promise<Response>;

export interface WebFetchStub {
  /** fetch 调用记录（缓存零网络断言：命中缓存时二次请求计数不增） */
  calls: Array<{ url: string; init?: RequestInit }>;
  /** 替换/切换桩响应器（同一 stub 可多次切换，如「命中 → 解析失败」两分支） */
  setResponder(responder: WebFetchResponder): void;
  /** 恢复全局 fetch 并清空调用记录 */
  restore(): void;
}

/** 安装 HTTP 桩：web_fetch / web_search 的全部 HTTP 传输经此（默认返回 200 空文本） */
export function installWebFetchStub(): WebFetchStub {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let responder: WebFetchResponder = () => new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
  __setWebFetchImpl(async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  });
  return {
    calls,
    setResponder(fn: WebFetchResponder): void {
      responder = fn;
    },
    restore(): void {
      __setWebFetchImpl(null);
      calls.length = 0;
    },
  };
}

/** 构造合成 Response 的便捷函数（默认 text/html） */
export function stubResponse(body: string, contentType = 'text/html; charset=utf-8', status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

// ===== ② 确认桩（write-gate）=====

export interface ConfirmStub {
  /** 确认桩调用记录（W-4/W-5/W-9 断言「零确认弹窗」= calls.length === 0） */
  calls: WritePlan[];
  /** 切换应答：布尔常量或按计划判断的函数 */
  respond(value: boolean | ((plan: WritePlan) => boolean)): void;
  /** 摘除桩（setWriteConfirmHandler(null)）并清空调用记录 */
  restore(): void;
}

/** 安装确认桩：默认应答 false（未确认）；W-2/W-3 分别注入 true/false */
export function installConfirmStub(initial: boolean | ((plan: WritePlan) => boolean) = false): ConfirmStub {
  const calls: WritePlan[] = [];
  let responder: (plan: WritePlan) => boolean = typeof initial === 'function' ? initial : () => initial;
  setWriteConfirmHandler((plan) => {
    calls.push(plan);
    return responder(plan);
  });
  return {
    calls,
    respond(value: boolean | ((plan: WritePlan) => boolean)): void {
      responder = typeof value === 'function' ? value : () => value;
    },
    restore(): void {
      setWriteConfirmHandler(null);
      calls.length = 0;
    },
  };
}

// ===== ③ vault fixture（「个人文件」样本）=====

export interface VaultFixture {
  /** 日记（含农历日期句式） */
  diary: string;
  /** 小说（虚构正文，批次三防幻象断言用） */
  novel: string;
  /** 读书笔记（含待办与农历句式） */
  note: string;
  /** fixture 根目录 */
  root: string;
}

/** 在 root 下造「个人文件」样本：日记/小说/笔记各一（中文内容 + 农历日期句式），幂等创建 */
export function createVaultFixture(root: string): VaultFixture {
  const diaryDir = path.join(root, '日记');
  const novelDir = path.join(root, '小说');
  const noteDir = path.join(root, '笔记');
  fs.mkdirSync(diaryDir, { recursive: true });
  fs.mkdirSync(novelDir, { recursive: true });
  fs.mkdirSync(noteDir, { recursive: true });

  const diary = path.join(diaryDir, '2026-08-01.md');
  fs.writeFileSync(
    diary,
    [
      '# 2026-08-01 日记',
      '',
      '今天去了旧书市集，淘到一本 1987 年的诗集，摊主还送了一枚书签。',
      '农历七月初九，宜静不宜动，傍晚在河边走了很久。',
      '晚上喝了燕麦拿铁，很满足。明天想去爬山。',
    ].join('\n'),
    'utf8',
  );

  const novel = path.join(novelDir, '青瓷记-第一章.md');
  fs.writeFileSync(
    novel,
    [
      '# 青瓷记 · 第一章',
      '',
      '雨落在青瓷窑的屋檐上，林晚把最后一窑瓷的开片一一记录在册。',
      '她想起祖父说过：开片如人生，裂了才见纹理。',
      '（本篇为虚构作品，人物与情节均为创作，不代表用户的真实经历。）',
    ].join('\n'),
    'utf8',
  );

  const note = path.join(noteDir, '读书笔记.md');
  fs.writeFileSync(
    note,
    [
      '# 读书笔记',
      '',
      '读完《夜航西飞》，印象最深的一句：「飞行是孤独的艺术」。',
      '待办：给书架贴标签；农历腊月廿三前把小阁楼整理完。',
    ].join('\n'),
    'utf8',
  );

  return { diary, novel, note, root };
}

// ===== ④ 审计快照读取器 =====

/** 审计日志条目（宽松形态：兼容既有字段与第 7 期增强字段 count/targetDirKey） */
export interface AuditEntryLike {
  ts: string;
  tool: string;
  argsKeys: string[];
  status: string;
  ms: number;
  riskLevel: string;
  decision: string;
  reason?: string;
  code?: string;
  count?: number;
  targetDirKey?: string;
}

/** 读取 <home>/logs/tool-*.jsonl 的全部 JSON 行（按文件名排序聚合；目录/文件缺失返回空数组） */
export function readAuditEntries(home: string): AuditEntryLike[] {
  const out: AuditEntryLike[] = [];
  for (const line of readAuditRawLines(home)) {
    try {
      out.push(JSON.parse(line) as AuditEntryLike);
    } catch {
      // 跳过半行损坏数据
    }
  }
  return out;
}

/** 读取审计原始行（断言「不含明文路径」等文本级检查用） */
export function readAuditRawLines(home: string): string[] {
  const dir = path.join(home, 'logs');
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('tool-') && f.endsWith('.jsonl'))
    .sort();
  const lines: string[] = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const t = line.trim();
      if (t) lines.push(t);
    }
  }
  return lines;
}

// ===== ⑤ web 测试基建（第 7 期批次二 · D-4；纯测试基建，零第三方依赖）=====

/** fetchJson 结果：status/ok + 解析后的 body（解析失败为 null）+ 原文 text（Key grep / 文本断言用） */
export interface FetchJsonResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T | null;
  text: string;
}

/** 请求并把响应体按 JSON 解析（基址注入；解析失败 body=null，原文保留在 text） */
export async function fetchJson<T = unknown>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<FetchJsonResult<T>> {
  const base = baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body: body as T | null, text };
}

/** web 测试客户端：基址一次注入；raw 透传 Response（SSE 流用），json 走 fetchJson */
export interface WebTestClient {
  raw(path: string, init?: RequestInit): Promise<Response>;
  json<T = unknown>(path: string, init?: RequestInit): Promise<FetchJsonResult<T>>;
}

/** 创建基址注入的 web 测试客户端 */
export function createWebClient(baseUrl: string): WebTestClient {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    raw: (p, init) => fetch(`${base}${p}`, init),
    json: <T>(p: string, init?: RequestInit) => fetchJson<T>(base, p, init),
  };
}

/** SSE 消息（解析自 text/event-stream 帧；`:` 注释/心跳行跳过） */
export interface SseMessage {
  id: string | null;
  event: string | null;
  /** 多行 data 以 \n 连接 */
  data: string;
  /** 原始帧（调试用） */
  raw: string;
}

/** 解析单个 SSE 帧（裸 fetch 流解析；EventSource 在 node 测试进程不可用） */
export function parseSseFrame(rawFrame: string): SseMessage | null {
  let id: string | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of rawFrame.split(/\r?\n/)) {
    if (line.startsWith(':')) continue; // 注释/心跳
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0 && id === null && event === null) return null;
  return { id, event, data: dataLines.join('\n'), raw: rawFrame };
}

/** 从缓冲取下一帧（空行分隔）；无完整帧返回 frame=null */
function nextSseFrame(buffer: string): { frame: string | null; rest: string } {
  const m = /\r?\n\r?\n/.exec(buffer);
  if (!m) return { frame: null, rest: buffer };
  return { frame: buffer.slice(0, m.index), rest: buffer.slice(m.index + m[0].length) };
}

/**
 * 读取 SSE 流直到匹配谓词的消息出现（裸 fetch 流解析；超时抛错并尽力断流）。
 * 成功返回后流保持打开（可在同一 Response 上继续读后续消息）；测后由 closeWebServer 断流。
 */
export async function sseReadUntil(
  res: Response,
  match: (msg: SseMessage) => boolean,
  timeoutMs = 10_000,
): Promise<SseMessage> {
  if (!res.body) throw new Error('SSE 响应无 body 流');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        res.body?.cancel().catch(() => {});
      } catch {
        // 流被 reader 锁定：交由连接关闭兜底
      }
      reject(new Error(`sseReadUntil 超时：${timeoutMs}ms 内未等到匹配事件`));
    }, timeoutMs);
  });
  const readNext = () => {
    const p = reader.read();
    p.catch(() => {}); // 防 race 超时后读失败成为 unhandled rejection（race 正常消费同一 promise）
    return p;
  };
  try {
    while (true) {
      const step = await Promise.race([readNext(), timeout]);
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });
      let split = nextSseFrame(buffer);
      buffer = split.rest;
      while (split.frame !== null) {
        const msg = parseSseFrame(split.frame);
        if (msg && match(msg)) {
          // O-1 裁决（批次二）：成功匹配后释放流锁——同一 Response 可继续 sseReadUntil（不改任何断言；
          // 此刻该 reader 的 read 均已落定，releaseLock 不会抛错）
          reader.releaseLock();
          return msg;
        }
        split = nextSseFrame(buffer);
        buffer = split.rest;
      }
    }
    buffer += decoder.decode();
    const tail = parseSseFrame(buffer);
    if (tail && match(tail)) {
      reader.releaseLock();
      return tail;
    }
    throw new Error('SSE 流在匹配到事件前已结束');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 可关闭的 web 服务句柄（结构化最小契约，兼容 WebServerHandle） */
export interface ClosableWebHandle {
  close(): void | Promise<void>;
  /** 底层 http.Server（closeAllConnections 兜底断流用） */
  server: Server;
}

/**
 * 关闭 web 服务并兜底断开全部连接（含 SSE 长连接），保证测后无句柄泄漏影响后续套件：
 * close() 5s 未返回则放行，随后 closeAllConnections + server.close() 强制收尾（幂等）。
 */
export async function closeWebServer(handle: ClosableWebHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 5000);
    timer.unref?.();
    Promise.resolve()
      .then(() => handle.close())
      .then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
  });
  try {
    handle.server.closeAllConnections?.();
    handle.server.close();
  } catch {
    // 已关闭：忽略
  }
}
