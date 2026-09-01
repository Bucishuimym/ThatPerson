/**
 * web 本地服务（第 7 期批次二 · KS-7.26 / T6）
 *
 * 契约（D-4 红侧先行，tests/web.test.ts 为实现判据）：
 * - startWebServer(opts) → Promise<WebServerHandle>；只绑 127.0.0.1（localhost 铁律），
 *   缺省随机端口（listen(0) 取实际端口），--port <n> 经 opts.port 指定；
 * - WebServerHandle { port, close(), server }：close() 必须断开全部活动连接（含 SSE 长连接，防句柄泄漏）；
 *   server 为底层 http.Server，供测试断言 address() 绑定 127.0.0.1；
 * - opts.open=true 且交互 TTY 才开浏览器（platform spawn；缺省/非 TTY 不开）；isMock 注入 --mock 语义；
 * - REST：GET /api/tree?root= ｜ GET /api/file?path= ｜ POST /api/file {path,content,confirm?}
 *   ｜ GET /api/vaults ｜ GET /api/events（SSE：id=seq，环形缓冲 100 + Last-Event-ID 补发 BC-7-4）｜ POST /api/chat {message}；
 * - 结构化拒绝：越界 403 {code:'path-denied',unlockHint}；红线名 403 {code:'redline-denied'}（无解锁）；
 *   覆盖无 confirm 409 {code:'conflict'}；其余 404；异常 500 {error}（不含堆栈/路径/Key）。
 *
 * 安全（SEC-6 localhost 铁律）：
 * - 全部响应零 Key（服务端从不回显 config.apiKey，错误信息用泛化文案）；
 * - 只绑 127.0.0.1；只服务内联 HTML（GET /），无静态目录 → 无目录遍历面；
 * - 白名单语义与工具层同源（assertPathAllowed），allowedRoots 每请求现算（allow-dir 即时生效，KS-39）。
 *
 * 零框架 node:http/node:fs/node:path；本期零新依赖。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { INDEX_HTML } from './public';
import { clearEventSinks, emitEvent, subscribeEventSink, type AgentEvent, type EventSink } from '../events';
import { listAllowedDirs, memoryRoot, thatPersonHome } from '../config';
import { vaultRoot } from '../vault';
import { assertPathAllowed } from '../tools/guards';
import { createMemoryStore } from '../memory/store';
import { loadPresent } from '../present';
import { runAgentLoop } from '../agent/loop';
import { listTools } from '../tools/registry';

/** startWebServer 句柄：port = 实际监听端口；close() 断开全部连接并停机；server = 底层 http.Server（测试可观测） */
export interface WebServerHandle {
  port: number;
  close(): void | Promise<void>;
  /** 底层 http.Server：测试断言 server.address() 绑定 127.0.0.1（localhost 铁律）用 */
  server: Server;
}

/** startWebServer 选项：open 是否自动开浏览器（缺省不开；true 且交互 TTY 才开）；port 指定端口（缺省随机）；isMock 注入离线 mock 语义 */
export interface StartWebServerOptions {
  open?: boolean;
  port?: number;
  /** --mock 语义：服务端对话走离线 mock（零网络零 Key）；缺省 false（CLI 以 --mock 透传） */
  isMock?: boolean;
}

/** 路径拒绝解锁提示（与 tools/executor 的 PATH_DENIED_HINT 同文案；该常量未导出，此处按字面对齐，不含明文路径/home 根） */
const PATH_DENIED_HINT = '该路径不在允许目录内；如需访问请运行 thatperson allow-dir <路径> 授权后重试';
/** SSE 环形缓冲上限（BC-7-4：最近 100 条，重连补发用） */
const EVENT_BUFFER_LIMIT = 100;
/** SSE 心跳间隔（注释帧，15s） */
const SSE_HEARTBEAT_MS = 15_000;
/** POST 请求体上限（1 MiB，防滥用） */
const BODY_LIMIT_BYTES = 1024 * 1024;
/** 文件树跳过项（依赖/构建产物，噪声目录） */
const TREE_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-test']);

/** 敏感文件名红线（与 tools/plugins/write-file 的 isRedlinedName 同口径：.env* / *api-key* / *.key / .gitignore） */
function isRedlinedName(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.') || lower.startsWith('.env-')) return true;
  if (lower.includes('api-key')) return true;
  if (lower.endsWith('.key')) return true;
  if (lower === '.gitignore') return true;
  return false;
}

/** 内容清洗（与 write_file 插件同口径）：只转义 < > 防标签闭合，保留换行（DD-7.1 有意取舍） */
function escapeAngleKeepNewlines(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * web 白名单根：[home, vaultRoot(), cwd, ...config.allowedDirs]（resolve 去重）。
 * 每次请求现算（不缓存）：allow-dir 授权后即时生效（KS-39 同语义）。
 */
function webAllowedRoots(): string[] {
  return [...new Set(
    [thatPersonHome(), vaultRoot(), process.cwd(), ...listAllowedDirs()].map((p) => path.resolve(p)),
  )];
}

// ===== SSE 环形缓冲（模块内保存，BC-7-4）=====

/** 最近 100 条事件缓冲（seq 进程级单调，多服务实例按 seq 去重只入一次） */
const eventBuffer: AgentEvent[] = [];
let lastBufferedSeq = 0;

function bufferEvent(event: AgentEvent): void {
  if (event.seq <= lastBufferedSeq) return; // 已由同进程其他 sink 入过缓冲
  eventBuffer.push(event);
  lastBufferedSeq = event.seq;
  if (eventBuffer.length > EVENT_BUFFER_LIMIT) {
    eventBuffer.splice(0, eventBuffer.length - EVENT_BUFFER_LIMIT);
  }
}

// ===== 响应工具 =====

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

function json(status: number, body: Record<string, unknown>): JsonResponse {
  return { status, body };
}

function respondJson(res: ServerResponse, out: JsonResponse): void {
  res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(out.body));
}

/** 读取请求体（UTF-8）；超限/出错返回 null */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        done(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done(null));
  });
}

/** 解析 JSON 请求体；失败/超限返回 null */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ===== REST 处理器 =====

/** GET /api/tree?root= ：白名单校验 → 两层目录树 { root, children:[{name,type,path}] }（跳过 node_modules/.git/dist） */
function handleTree(url: URL): JsonResponse {
  const raw = (url.searchParams.get('root') ?? '').trim();
  if (!raw) return json(400, { error: '缺少 root 参数' });
  const safe = assertPathAllowed(raw, webAllowedRoots());
  if (!safe) return json(403, { code: 'path-denied', unlockHint: PATH_DENIED_HINT });
  let stat: fs.Stats;
  try {
    stat = fs.statSync(safe);
  } catch {
    return json(404, { error: '目录不存在' });
  }
  if (!stat.isDirectory()) return json(400, { error: 'root 不是目录' });
  const children: Array<{ name: string; type: 'dir' | 'file'; path: string }> = [];
  for (const entry of fs.readdirSync(safe, { withFileTypes: true })) {
    if (TREE_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
    children.push({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      path: path.join(safe, entry.name),
    });
  }
  children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return json(200, { root: safe, children });
}

/** GET /api/file?path= ：白名单 + 存在 + isFile → { ok:true, content } */
function handleFileGet(url: URL): JsonResponse {
  const raw = (url.searchParams.get('path') ?? '').trim();
  if (!raw) return json(400, { error: '缺少 path 参数' });
  const safe = assertPathAllowed(raw, webAllowedRoots());
  if (!safe) return json(403, { code: 'path-denied', unlockHint: PATH_DENIED_HINT });
  let stat: fs.Stats;
  try {
    stat = fs.statSync(safe);
  } catch {
    return json(404, { error: '文件不存在' });
  }
  if (!stat.isFile()) return json(400, { error: '目标不是文件' });
  let content = '';
  try {
    content = fs.readFileSync(safe, 'utf8');
  } catch {
    return json(500, { error: '文件读取失败' });
  }
  return json(200, { ok: true, path: safe, content });
}

/** POST /api/file {path,content,confirm?} ：红线拒绝 → 白名单 → 覆盖分档（409）→ 落盘（<> 转义保留换行） */
async function handleFilePost(req: IncomingMessage): Promise<JsonResponse> {
  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: '请求体应为 JSON 对象' });
  const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
  const content = typeof body.content === 'string' ? body.content : null;
  if (!rawPath || content === null) return json(400, { error: 'path 与 content 为必填字符串' });
  const confirm = body.confirm === true;
  // ① 红线优先（KS-35：敏感文件永远拒绝，无解锁路径）
  if (isRedlinedName(path.basename(rawPath))) return json(403, { code: 'redline-denied' });
  // ② 路径白名单（同工具层 assertPathAllowed 语义）
  const safe = assertPathAllowed(rawPath, webAllowedRoots());
  if (!safe) return json(403, { code: 'path-denied', unlockHint: PATH_DENIED_HINT });
  // ③ 覆盖分档：已存在且未 confirm → 409 conflict（不落盘）
  if (fs.existsSync(safe) && !confirm) return json(409, { code: 'conflict' });
  // ④ 写盘（<> 转义保留换行；不存在则创建含父目录）
  try {
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, escapeAngleKeepNewlines(content), 'utf8');
  } catch {
    return json(500, { error: '文件写入失败' });
  }
  return json(200, { ok: true, path: safe });
}

/**
 * GET /api/vaults（T10 多仓）：挂载根 = 默认 vault + config.allowedDirs 中存在且为目录的。
 * roots: string[]（既有契约形态不变，WB-6/WB-7/e2e 按字符串路径断言）；
 * mounts: 附加来源标注 [{ name, path, source:'vault'|'allowed-dir' }]（同路径 vault 优先，供前端每根标注来源）；
 * 响应零 apiKey 字段。
 */
function handleVaults(): JsonResponse {
  const vaultPath = path.resolve(vaultRoot());
  const roots = [vaultPath];
  for (const dir of listAllowedDirs()) {
    try {
      if (fs.statSync(dir).isDirectory()) roots.push(path.resolve(dir));
    } catch {
      // 不存在/不可访问：跳过
    }
  }
  const uniqueRoots = [...new Set(roots)];
  const seen = new Set<string>();
  const mounts: Array<{ name: string; path: string; source: 'vault' | 'allowed-dir' }> = [];
  for (const root of uniqueRoots) {
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mounts.push({
      name: path.basename(root) || root,
      path: root,
      source: key === vaultPath.toLowerCase() ? 'vault' : 'allowed-dir',
    });
  }
  return json(200, { roots: uniqueRoots, mounts });
}

/** POST /api/chat {message} ：runAgentLoop（服务端进程持有 Key，前端 token-less）；事件经总线推 SSE；响应返回最终回复 */
async function handleChat(req: IncomingMessage, opts: StartWebServerOptions): Promise<JsonResponse> {
  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: '请求体应为 JSON 对象' });
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return json(400, { error: 'message 不能为空' });
  try {
    const store = createMemoryStore(memoryRoot());
    store.ensureStructure();
    const memories = await store.load();
    const { reply } = await runAgentLoop({
      userPrompt: message,
      memories,
      isMock: opts.isMock === true,
      present: loadPresent(),
      tools: listTools(),
    });
    // 会话事件协议：agent_message（最终回复进 SSE，前端入对话气泡；loop 内部不发该事件，由本出口补发）
    emitEvent({ type: 'agent_message', role: 'assistant', content: reply, streaming: false });
    return json(200, { reply });
  } catch {
    // 泛化文案：不含堆栈/明文路径/Key
    return json(500, { error: '对话处理失败' });
  }
}

// ===== SSE =====

/** 向单个 SSE 连接写一帧（id=seq，data=事件 JSON）；连接已断时静默 */
function writeSseFrame(res: ServerResponse, event: AgentEvent): void {
  try {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  } catch {
    // 连接已断：忽略（close 事件会移除）
  }
}

/** GET /api/events ：SSE 订阅（Last-Event-ID 补发 → 实时推送 → 15s 心跳；连接 close 反注册） */
function handleEvents(req: IncomingMessage, res: ServerResponse, state: ServerState): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // 立即冲刷响应头 + 首个注释帧：保证客户端 fetch/EventSource 尽快就绪（sink 已同步注册），不等首个事件
  res.flushHeaders();
  res.write(': connected\n\n');
  state.sseConnections.add(res);
  // BC-7-4：带 Last-Event-ID 重连 → 补发缓冲中 seq 更大的事件（按 seq 顺序）；
  // 逐事件分 tick 写出：保证每帧独立分块到达，客户端可逐帧 sseReadUntil（WB-2-2 二次读取语义）
  const lastIdRaw = req.headers['last-event-id'];
  const lastId = typeof lastIdRaw === 'string' ? Number.parseInt(lastIdRaw, 10) : Number.NaN;
  if (Number.isFinite(lastId)) {
    let chain: Promise<void> = Promise.resolve();
    for (const event of eventBuffer) {
      if (event.seq <= lastId) continue;
      chain = chain.then(
        () =>
          new Promise<void>((resolveTick) => {
            setImmediate(() => {
              if (!state.closed && !res.destroyed) writeSseFrame(res, event);
              resolveTick();
            });
          }),
      );
    }
  }
  const drop = (): void => {
    state.sseConnections.delete(res);
  };
  res.on('close', drop);
  res.on('error', drop);
}

// ===== 路由与服务生命周期 =====

interface ServerState {
  /** 活动中的 SSE 连接（close() 时统一断开） */
  readonly sseConnections: Set<ServerResponse>;
  closed: boolean;
}

/** 请求分发；未匹配 → 404；异常 → 500 泛化 JSON（不含堆栈/路径/Key） */
async function route(req: IncomingMessage, res: ServerResponse, opts: StartWebServerOptions, state: ServerState): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'GET' && pathname === '/') {
      // 只服务内联 HTML（无静态目录 → 无目录遍历面）；其余静态路径一律 404
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }
    if (method === 'GET' && pathname === '/api/events') {
      handleEvents(req, res, state);
      return;
    }
    if (method === 'GET' && pathname === '/api/tree') {
      respondJson(res, handleTree(url));
      return;
    }
    if (method === 'GET' && pathname === '/api/file') {
      respondJson(res, handleFileGet(url));
      return;
    }
    if (method === 'POST' && pathname === '/api/file') {
      respondJson(res, await handleFilePost(req));
      return;
    }
    if (method === 'GET' && pathname === '/api/vaults') {
      respondJson(res, handleVaults());
      return;
    }
    if (method === 'POST' && pathname === '/api/chat') {
      respondJson(res, await handleChat(req, opts));
      return;
    }
    respondJson(res, json(404, { error: 'not-found' }));
  } catch {
    if (!res.headersSent) respondJson(res, json(500, { error: 'internal-error' }));
    else res.end();
  }
}

/** 自动开浏览器（platform spawn；仅 CLI 交互场景调用，失败静默不开） */
function openBrowser(url: string): void {
  void (async () => {
    try {
      const { spawn } = await import('node:child_process');
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {
      // 开浏览器失败静默：不影响服务
    }
  })();
}

/**
 * 起本地 web 服务（只绑 127.0.0.1；缺省随机端口 listen(0)）。
 * close()：断开全部 SSE 连接 → 清全部事件 sink（sink 为进程级单例，防污染后续测试/其他输出通道）→ 停止心跳 → server.close()。
 */
export async function startWebServer(opts: StartWebServerOptions = {}): Promise<WebServerHandle> {
  const state: ServerState = { sseConnections: new Set<ServerResponse>(), closed: false };
  const server = http.createServer((req, res) => {
    void route(req, res, opts, state);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // localhost 铁律：只绑 127.0.0.1；port 缺省 0（随机端口，实际端口取 address()）
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : (opts.port ?? 0);

  // SSE 心跳（注释帧）：15s 一次，防代理/客户端空闲断连
  const heartbeat = setInterval(() => {
    for (const res of [...state.sseConnections]) {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        // 连接已断：忽略
      }
    }
  }, SSE_HEARTBEAT_MS);

  // 事件 sink：入环形缓冲（进程级去重）+ 推送本服务全部 SSE 连接
  const sink: EventSink = (event) => {
    bufferEvent(event);
    for (const res of [...state.sseConnections]) writeSseFrame(res, event);
  };
  subscribeEventSink(sink);

  const handle: WebServerHandle = {
    port,
    server,
    close(): void {
      if (state.closed) return;
      state.closed = true;
      clearInterval(heartbeat);
      for (const res of [...state.sseConnections]) {
        try {
          res.end();
        } catch {
          // 连接已断：忽略
        }
      }
      state.sseConnections.clear();
      clearEventSinks();
      try {
        server.close();
      } catch {
        // 已关闭：忽略
      }
    },
  };
  // 自动开浏览器：仅显式 open:true 且交互 TTY（测试/管道/服务场景不开）
  if (opts.open === true && process.stdin.isTTY) openBrowser(`http://127.0.0.1:${port}`);
  return handle;
}
