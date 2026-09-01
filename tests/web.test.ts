/**
 * web MVP 测试（第 7 期批次二 · WB-1~4 / WB-6 + 对话 REST；KS-7.26 / T6/T8）
 *
 * 全部用例 node fetch 打 127.0.0.1 真实端口，测后 closeWebServer 兜底断流（防句柄泄漏）。
 *
 * 契约（D-4 红侧先行，D-2 按此实现）：
 * - startWebServer({ open?, port?, isMock? }) → WebServerHandle { port, close(), server }
 *   （server 字段供测试断言 address() 绑定 127.0.0.1 —— O-1 裁决点；close() 必须断开全部活动连接含 SSE）
 * - REST：GET /api/tree?root=（目录树 JSON）｜ GET /api/file?path=（JSON，含 content 字段）
 *   ｜ POST /api/file {path,content,confirm?}（服务端 assertPathAllowed + 红线名拒绝 + 覆盖需 confirm）
 *   ｜ GET /api/vaults（挂载根 = 默认 vault + config.allowedDirs）｜ GET /api/events（SSE）｜ POST /api/chat {message}
 * - 结构化拒绝：越界 403 {code:'path-denied',unlockHint}；红线名 403 {code:'redline-denied'}（无解锁）；
 *   覆盖无 confirm 409 {code:'conflict'}
 * - SSE：id=seq；环形缓冲 100 + Last-Event-ID 重连补发（BC-7-4）
 * - 对话：POST /api/chat mock 语义（opts.isMock 注入）→ {reply}；SSE 同步收到 agent_message
 * - Key 不落前端（SEC-6）：静态页与全部 API 响应 grep 无 sk- 形态
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startWebServer, type WebServerHandle } from '../src/web/server';
import { emitEvent } from '../src/events';
import { allowDir, ensureConfigDir } from '../src/config';
import { PARA_DIRS, ensureParaVault } from '../src/vault';
import { isolateHome } from './helpers';
import { closeWebServer, createWebClient, sseReadUntil, type WebTestClient } from './mocks';

const iso = isolateHome();
const savedVaultRoot = process.env.THATPERSON_VAULT_ROOT;
delete process.env.THATPERSON_VAULT_ROOT;
test.after(() => {
  if (savedVaultRoot === undefined) delete process.env.THATPERSON_VAULT_ROOT;
  else process.env.THATPERSON_VAULT_ROOT = savedVaultRoot;
  iso.restore();
});

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 统一起服务：open:false（测试环境不弹浏览器）+ isMock:true（全程离线零网络零 Key）；测后必须 closeWebServer */
async function start(opts: { port?: number } = {}): Promise<{ handle: WebServerHandle; api: WebTestClient }> {
  const handle = await startWebServer({ open: false, isMock: true, ...opts });
  return { handle, api: createWebClient(`http://127.0.0.1:${handle.port}`) };
}

const settle = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 线上小写化路径比较（Windows 大小写不敏感） */
const samePath = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// ===== WB-1 起服务与四面板 =====

test('WB-1 web 服务：随机端口 + 仅绑 127.0.0.1 + GET / 四面板标记齐全', async () => {
  const h1 = await start();
  const h2 = await start();
  try {
    assert.ok(h1.handle.port > 0 && h2.handle.port > 0, '应取实际监听端口（listen(0) 语义）');
    assert.notEqual(h1.handle.port, h2.handle.port, '两次起服务应各得随机端口');
    for (const { handle } of [h1, h2]) {
      const addr = handle.server.address();
      assert.ok(addr && typeof addr === 'object', 'address() 应为 AddressInfo');
      assert.equal((addr as AddressInfo).address, '127.0.0.1', '必须只绑 127.0.0.1（localhost 铁律）');
    }
    const res = await h1.api.raw('/');
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const panel of ['file-tree', 'editor', 'chat', 'activity']) {
      assert.ok(html.includes(`data-panel="${panel}"`), `四面板应含 data-panel="${panel}" 标记`);
    }
  } finally {
    await closeWebServer(h1.handle);
    await closeWebServer(h2.handle);
  }
});

// ===== WB-2 SSE =====

test('WB-2 SSE：GET /api/events 事件流语义，另一连接触发 emitEvent 后收到 id=seq 的事件', async () => {
  const { handle, api } = await start();
  try {
    const sse = await api.raw('/api/events', { headers: { accept: 'text/event-stream' } });
    assert.equal(sse.status, 200);
    assert.ok(
      (sse.headers.get('content-type') ?? '').startsWith('text/event-stream'),
      'content-type 应为 text/event-stream（EventSource 语义）',
    );
    await settle(200); // 等服务端注册 sink（fetch 返回仅代表响应头已发出）
    // 另一连接触发：直接调事件总线注入一条 tool_call 假事件
    emitEvent({ type: 'tool_call', name: 'read_file', argsKeys: ['path'], policy: 'read', riskLevel: 'L0' });
    const msg = await sseReadUntil(sse, (m) => m.data.includes('"tool_call"'));
    assert.ok(msg.id !== null && msg.id !== '', 'SSE 消息应带 id:');
    const payload = JSON.parse(msg.data) as Record<string, unknown>;
    assert.equal(payload.type, 'tool_call', 'SSE data 应为事件 JSON');
    assert.equal(String(msg.id), String(payload.seq), 'SSE id 应等于事件 seq');
    assert.equal(payload.name, 'read_file');
  } finally {
    await closeWebServer(handle);
  }
});

test('WB-2 SSE：断开重连带 Last-Event-ID 补发缺失事件（BC-7-4 环形缓冲）', async () => {
  const { handle, api } = await start();
  try {
    const ac = new AbortController();
    const first = await api.raw('/api/events', {
      headers: { accept: 'text/event-stream' },
      signal: ac.signal,
    });
    await settle(200);
    emitEvent({ type: 'status', phase: 'start' });
    const m1 = await sseReadUntil(first, (m) => m.data.includes('"status"'));
    const lastId = m1.id;
    assert.ok(lastId !== null && lastId !== '', '断开前应收到带 id 的事件');
    ac.abort(); // 断开
    // 断开期间再注入两条（服务端环形缓冲应保留）
    emitEvent({ type: 'agent_message', role: 'assistant', content: '补发事件一', streaming: false });
    emitEvent({ type: 'agent_message', role: 'assistant', content: '补发事件二', streaming: false });
    // 重连带 Last-Event-ID → 应补发缺失事件
    const second = await api.raw('/api/events', {
      headers: { accept: 'text/event-stream', 'last-event-id': String(lastId) },
    });
    const r1 = await sseReadUntil(second, (m) => m.data.includes('补发事件一'));
    const r2 = await sseReadUntil(second, (m) => m.data.includes('补发事件二'));
    for (const [i, r] of [r1, r2].entries()) {
      assert.ok(r.id !== null && Number(r.id) > Number(lastId), `补发事件 ${i + 1} 的 id 应大于 Last-Event-ID`);
    }
    assert.ok(Number(r1.id) < Number(r2.id), '补发应按 seq 顺序');
    const p1 = JSON.parse(r1.data) as Record<string, unknown>;
    assert.equal(p1.type, 'agent_message', '补发事件应为完整事件 JSON');
  } finally {
    await closeWebServer(handle);
  }
});

// ===== WB-3 REST 守卫 =====

test('WB-3 REST 守卫：tree/file 白名单内 200；越界 403 path-denied；红线写拒绝；覆盖 409/confirm 分档', async () => {
  const vault = ensureParaVault().root;
  const demoPath = path.join(vault, 'Projects', 'demo.md');
  fs.mkdirSync(path.dirname(demoPath), { recursive: true }); // fixture：目录就绪（WB-5 已覆盖 PARA 生成行为）
  fs.writeFileSync(demoPath, '# Demo\n白名单内内容', 'utf8');
  const outside = tmpDir('thatperson-web-out-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), '越界内容', 'utf8');
  const { handle, api } = await start();
  try {
    // tree：vault 目录树 JSON 含五目录
    const tree = await api.json(`/api/tree?root=${encodeURIComponent(vault)}`);
    assert.equal(tree.status, 200, `GET /api/tree 应 200，实际：${tree.status} ${tree.text.slice(0, 120)}`);
    for (const dir of PARA_DIRS) {
      assert.ok(tree.text.includes(dir), `文件树应含 ${dir}`);
    }
    // 读白名单内文件 → 200 + content
    const file = await api.json<{ content?: string }>(`/api/file?path=${encodeURIComponent(demoPath)}`);
    assert.equal(file.status, 200, `GET /api/file 应 200，实际：${file.status} ${file.text.slice(0, 120)}`);
    assert.ok(file.body !== null && typeof file.body.content === 'string', '读文件应返回含 content 字段的 JSON');
    assert.ok((file.body as { content: string }).content.includes('白名单内内容'), 'content 应为文件内容');
    // 越界读（allowedRoots 外）→ 403 结构化拒绝带 unlockHint
    const denied = await api.json(`/api/file?path=${encodeURIComponent(path.join(outside, 'secret.txt'))}`);
    assert.equal(denied.status, 403, '越界读应 403');
    const deniedBody = denied.body as { code?: string; unlockHint?: string } | null;
    assert.equal(deniedBody?.code, 'path-denied', '越界应返回 code=path-denied');
    assert.ok(typeof deniedBody?.unlockHint === 'string' && deniedBody.unlockHint.length > 0, '结构化拒绝应带 unlockHint');
    // 越界树 → 403
    const treeDenied = await api.json(`/api/tree?root=${encodeURIComponent(outside)}`);
    assert.equal(treeDenied.status, 403, '越界 root 的树也应 403');
    // 红线文件写 → 拒绝（无解锁）
    const envWrite = await api.json('/api/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(vault, '.env'), content: 'LEAK=1' }),
    });
    assert.equal(envWrite.status, 403, '.env 写应拒绝');
    assert.equal((envWrite.body as { code?: string } | null)?.code, 'redline-denied', '.env 应返回 code=redline-denied');
    assert.ok(!fs.existsSync(path.join(vault, '.env')), '红线文件不应落盘');
    const gitignoreWrite = await api.json('/api/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(vault, '.gitignore'), content: 'node_modules' }),
    });
    assert.equal(gitignoreWrite.status, 403, '.gitignore 写应拒绝');
    assert.ok(!fs.existsSync(path.join(vault, '.gitignore')), '红线文件不应落盘');
    // 覆盖分档：无 confirm → 409 conflict 且不落盘
    const noConfirm = await api.json('/api/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: demoPath, content: '未确认的新内容' }),
    });
    assert.equal(noConfirm.status, 409, '覆盖已存在文件无 confirm 应 409');
    assert.equal((noConfirm.body as { code?: string } | null)?.code, 'conflict', '应返回 code=conflict');
    assert.ok(fs.readFileSync(demoPath, 'utf8').includes('白名单内内容'), '无 confirm 不应覆盖');
    // 带 confirm:true → 成功
    const withConfirm = await api.json('/api/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: demoPath, content: '已确认的新内容', confirm: true }),
    });
    assert.ok(withConfirm.status >= 200 && withConfirm.status < 300, 'confirm:true 覆盖应成功');
    assert.equal(fs.readFileSync(demoPath, 'utf8'), '已确认的新内容', '覆盖应落盘');
    // 新建无需 confirm 也应成功
    const createRes = await api.json('/api/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(vault, '0-Inbox', 'new-by-web.md'), content: '新建' }),
    });
    assert.ok(createRes.status >= 200 && createRes.status < 300, '新建文件无需 confirm 应成功');
    assert.ok(fs.existsSync(path.join(vault, '0-Inbox', 'new-by-web.md')), '新建应落盘');
  } finally {
    await closeWebServer(handle);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ===== WB-4 Key 不落前端 =====

test('WB-4 Key 不落前端：预置假 Key 后全部响应 grep 无 sk-，/api/vaults 无 apiKey 字段', async () => {
  // 隔离 home 预置假 Key：服务端进程会加载它，断言任何响应不外泄（掩码形态 sk-*** 也算 sk- 命中）
  const { configPath } = ensureConfigDir();
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ model: 'deepseek-v4-flash', apiKey: 'sk-fake1234abcd', configured: true }, null, 2)}\n`,
    'utf8',
  );
  const vault = ensureParaVault().root;
  const { handle, api } = await start();
  try {
    const targets = ['/', `/api/tree?root=${encodeURIComponent(vault)}`, '/api/vaults', `/api/file?path=${encodeURIComponent(path.join(vault, 'README.md'))}`];
    for (const t of targets) {
      const res = await api.raw(t);
      assert.equal(res.status, 200, `${t} 应 200（保证 grep 非空响应）`);
      const text = await res.text();
      assert.ok(!text.includes('sk-'), `${t} 响应不得含 sk- 形态（含掩码 sk-***）`);
    }
    const vaults = await api.json('/api/vaults');
    assert.equal(vaults.status, 200);
    assert.ok(!vaults.text.includes('"apiKey"'), '/api/vaults 响应不得含 apiKey 字段');
  } finally {
    await closeWebServer(handle);
    // 还原隔离 home 配置（不污染后续用例）
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ model: 'deepseek-v4-flash', disabledSkills: [], configured: false }, null, 2)}\n`,
      'utf8',
    );
  }
});

// ===== WB-6 open 授权闭环 =====

test('WB-6 open 闭环：config 层 allowDir 后 /api/vaults 含该目录、/api/tree 可浏览；未授权目录 403', async () => {
  const granted = tmpDir('thatperson-web-open-');
  fs.writeFileSync(path.join(granted, 'note.md'), '# 便签\n授权目录内容', 'utf8');
  const other = tmpDir('thatperson-web-nope-');
  fs.writeFileSync(path.join(other, 'private.md'), '未授权内容', 'utf8');
  const vault = ensureParaVault().root;
  const grant = allowDir(granted); // 对齐既有 allow-dir 指令契约：直接调 config 层
  assert.equal(grant.ok, true, `前置：allowDir 应成功，实际：${grant.ok ? '' : grant.error}`);
  const { handle, api } = await start();
  try {
    // /api/vaults：默认 vault + 授权目录
    const vaults = await api.json<{ roots?: string[] } | string[]>('/api/vaults');
    assert.equal(vaults.status, 200);
    const roots = Array.isArray(vaults.body) ? (vaults.body as string[]) : ((vaults.body as { roots?: string[] })?.roots ?? []);
    assert.ok(Array.isArray(roots) && roots.length > 0, '/api/vaults 应返回挂载根列表');
    assert.ok(roots.some((r) => samePath(r, vault)), '默认 vault 应在挂载根中');
    assert.ok(roots.some((r) => samePath(r, granted)), '/api/vaults 应含 open 授权目录');
    // 授权目录可浏览
    const tree = await api.json(`/api/tree?root=${encodeURIComponent(granted)}`);
    assert.equal(tree.status, 200, `授权目录树应 200，实际：${tree.status}`);
    assert.ok(tree.text.includes('note.md'), '授权目录文件树应可浏览');
    // 授权目录可写
    const write = await api.json('/api/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(granted, 'written-by-web.md'), content: 'web 写入' }),
    });
    assert.ok(write.status >= 200 && write.status < 300, '授权目录写应成功');
    assert.ok(fs.existsSync(path.join(granted, 'written-by-web.md')), '授权目录写应落盘');
    // 未授权目录：树与读一律结构化拒绝
    const otherTree = await api.json(`/api/tree?root=${encodeURIComponent(other)}`);
    assert.equal(otherTree.status, 403, '未授权目录树应 403');
    const otherFile = await api.json(`/api/file?path=${encodeURIComponent(path.join(other, 'private.md'))}`);
    assert.equal(otherFile.status, 403, '未授权目录读应 403');
    assert.equal((otherFile.body as { code?: string } | null)?.code, 'path-denied');
    assert.ok(typeof (otherFile.body as { unlockHint?: string } | null)?.unlockHint === 'string', '未授权拒绝应带 unlockHint');
  } finally {
    await closeWebServer(handle);
    fs.rmSync(granted, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

// ===== 对话 REST（--mock 语义）=====

test('对话 REST：POST /api/chat mock 语义返回 reply，SSE 同步收到 agent_message', async () => {
  ensureParaVault();
  const { handle, api } = await start(); // isMock:true 注入 --mock 语义
  try {
    const sse = await api.raw('/api/events', { headers: { accept: 'text/event-stream' } });
    const res = await api.json<{ reply?: string }>('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '你好（--mock 离线回复）' }),
    });
    assert.equal(res.status, 200, `POST /api/chat 应 200，实际：${res.status} ${res.text.slice(0, 120)}`);
    assert.equal(typeof res.body?.reply, 'string', '最终回复应以 reply 字段返回');
    assert.ok((res.body as { reply: string }).reply.length > 0, 'reply 不应为空');
    // SSE 同时收到 agent_message 事件
    const msg = await sseReadUntil(sse, (m) => m.data.includes('"agent_message"'), 20_000);
    const payload = JSON.parse(msg.data) as Record<string, unknown>;
    assert.equal(payload.type, 'agent_message');
    assert.equal(typeof payload.content, 'string', 'agent_message 应含 content');
    assert.ok(!res.text.includes('sk-'), '对话响应零 Key');
  } finally {
    await closeWebServer(handle);
  }
});

// ===== WB-7 多仓库并行（批次三 T10；纯追加，KS-7.27）=====

test('WB-7 多仓库：/api/vaults 多根并行可浏览；SSE 帧透传 vaultId 可选字段（带则含/不带则无，CLI 消费忽略）', async () => {
  // 第二仓库：open 授权目录（复用既有 allowedRoots 机制，跨仓库读写各自授权）
  const second = tmpDir('thatperson-web-vault2-');
  fs.writeFileSync(path.join(second, 'note-v2.md'), '第二仓库内容', 'utf8');
  const vault = ensureParaVault().root;
  const grant = allowDir(second);
  assert.equal(grant.ok, true, `前置：allowDir 应成功，实际：${grant.ok ? '' : String(grant.error)}`);
  const { handle, api } = await start();
  try {
    // /api/vaults：默认 vault + 授权目录 → 多根
    const vaults = await api.json<{ roots?: string[] } | string[]>('/api/vaults');
    assert.equal(vaults.status, 200);
    const roots = Array.isArray(vaults.body)
      ? (vaults.body as string[])
      : ((vaults.body as { roots?: string[] })?.roots ?? []);
    assert.ok(roots.length >= 2, `/api/vaults 应返回多根（默认 vault + 授权目录），实际：${JSON.stringify(roots)}`);
    assert.ok(roots.some((r) => samePath(r, vault)), '应含默认 vault 根');
    assert.ok(roots.some((r) => samePath(r, second)), '应含第二仓库根');
    // 双根并行可浏览：同一 server 上分别 /api/tree?root=
    const tree1 = await api.json(`/api/tree?root=${encodeURIComponent(vault)}`);
    const tree2 = await api.json(`/api/tree?root=${encodeURIComponent(second)}`);
    assert.equal(tree1.status, 200, '默认根树应 200');
    assert.equal(tree2.status, 200, `第二根树应 200（双根并行），实际：${tree2.status} ${tree2.text.slice(0, 120)}`);
    assert.ok(tree2.text.includes('note-v2.md'), '第二根文件树应可浏览');
    // SSE 帧透传 vaultId：注入带 vaultId 的假事件 → 帧 JSON 含该字段（web 活动轨道着色依据）
    const sse = await api.raw('/api/events', { headers: { accept: 'text/event-stream' } });
    await settle(200);
    emitEvent({ type: 'memory_read', phase: 'retrieve', vaultId: 'vault2', hits: 3, keywords: 2 });
    const withVault = await sseReadUntil(sse, (m) => m.data.includes('vault2'));
    const withPayload = JSON.parse(withVault.data) as Record<string, unknown>;
    assert.equal(withPayload.vaultId, 'vault2', 'SSE 帧应透传 vaultId 字段');
    // 可选字段语义：不带 vaultId 的事件帧不含该键（CLI 消费忽略该字段——e2e/242 既有覆盖，此处只断言事件层）
    emitEvent({ type: 'status', phase: 'start' });
    const noVault = await sseReadUntil(sse, (m) => m.data.includes('"status"'));
    const noPayload = JSON.parse(noVault.data) as Record<string, unknown>;
    assert.equal('vaultId' in noPayload, false, '未携带 vaultId 的事件帧不应出现该键（可选字段）');
  } finally {
    await closeWebServer(handle);
    fs.rmSync(second, { recursive: true, force: true });
  }
});
