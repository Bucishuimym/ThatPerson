/**
 * 更新检查测试（第 4 期 · S-07/S-08/S-18）
 * 覆盖：12h 缓存生效 / force 绕过缓存 / THATPERSON_DEV 跳过（本地路径不再豁免）/
 *       404 与网络错误静默失败 / version 数字分段比较 / 有新版时输出提示。
 * 全部离线：fetch 使用本地 stub，不发起真实网络请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkForUpdates,
  isNewerVersion,
  isUpdateCacheExpired,
  readCurrentVersion,
  recordUpdateCheck,
  shouldSkipUpdateCheck,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CACHE_FILE,
} from '../src/utils/update-check';
import { thatPersonHome } from '../src/config';
import { isolateHome } from './helpers';

const realVersion = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }
).version;

const iso = isolateHome();
test.after(() => iso.restore());

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-upd-'));
}

function cacheFile(): string {
  return path.join(thatPersonHome(), UPDATE_CACHE_FILE);
}

/** 每个用例前清空共享缓存，避免用例间相互影响 */
function resetCache(): void {
  try {
    fs.rmSync(cacheFile(), { force: true });
  } catch {
    // 忽略
  }
}

/** 捕获 console.log 输出 */
async function withCapturedLog(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs;
}

/** 安装 fetch stub：返回给定 version / 状态码 / 抛错 */
function stubFetch(version: string | null, status = 200, error?: Error): { calls: number } {
  const calls = { calls: 0 };
  globalThis.fetch = async () => {
    calls.calls += 1;
    if (error) throw error;
    if (version === null) return new Response('not found', { status });
    return new Response(JSON.stringify({ version }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

// ===== 纯函数：数字分段版本比较 =====

test('isNewerVersion：数字分段比较（1.1.0 > 1.0.0）', () => {
  assert.equal(isNewerVersion('1.1.0', '1.0.0'), true);
  assert.equal(isNewerVersion('2.0.0', '1.9.9'), true);
  assert.equal(isNewerVersion('1.10.0', '1.9.0'), true);
});

test('isNewerVersion：相同或更旧返回 false', () => {
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('0.9.9', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', '1.0.1'), false);
});

test('isNewerVersion：缺失段按 0、非法段按 0 处理', () => {
  assert.equal(isNewerVersion('1.1', '1.0.0'), true);
  assert.equal(isNewerVersion('1', '1.0.0'), false);
  assert.equal(isNewerVersion('abc', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.1', '1.0.x'), true);
});

// ===== 纯函数：缓存过期判定与记录 =====

test('isUpdateCacheExpired：无缓存文件 → 需要检查', () => {
  assert.equal(isUpdateCacheExpired(path.join(iso.home, 'no-such-cache'), Date.now()), true);
});

test('isUpdateCacheExpired：12h 内 → 不需要检查；超过 12h → 需要检查', () => {
  const file = path.join(iso.home, 'cache-expire-test');
  recordUpdateCheck(file, 1_000_000);
  assert.equal(isUpdateCacheExpired(file, 1_000_000 + UPDATE_CHECK_INTERVAL_MS - 1), false);
  assert.equal(isUpdateCacheExpired(file, 1_000_000 + UPDATE_CHECK_INTERVAL_MS), true);
});

test('isUpdateCacheExpired：内容非法 → 需要检查', () => {
  const file = path.join(iso.home, 'cache-invalid-test');
  fs.writeFileSync(file, 'not-a-number', 'utf8');
  assert.equal(isUpdateCacheExpired(file, Date.now()), true);
});

// ===== 跳过策略 =====

test('shouldSkipUpdateCheck：THATPERSON_DEV=true 时跳过', () => {
  const saved = process.env.THATPERSON_DEV;
  process.env.THATPERSON_DEV = 'true';
  try {
    assert.equal(shouldSkipUpdateCheck(tmpCwd()), true);
  } finally {
    if (saved === undefined) delete process.env.THATPERSON_DEV;
    else process.env.THATPERSON_DEV = saved;
  }
});

test('shouldSkipUpdateCheck：cwd 不再影响跳过判断（本地路径不豁免）', () => {
  assert.equal(shouldSkipUpdateCheck('G:\\XXFS\\Webstorm\\project\\ThatPerson'), false);
  assert.equal(shouldSkipUpdateCheck(tmpCwd()), false);
});

// ===== checkForUpdates：缓存 / 跳过 / 静默失败 =====

test('checkForUpdates：最新版大于当前版时输出更新提示', async () => {
  resetCache();
  const cwd = tmpCwd();
  const calls = stubFetch('1.1.0');
  const logs = await withCapturedLog(() =>
    checkForUpdates({ cwd, currentVersion: '1.0.0', registryUrl: 'https://stub.test/latest' }),
  );
  assert.equal(calls.calls, 1);
  assert.ok(logs.some((l) => l.includes('ThatPerson 新版本 1.1.0 可用') && l.includes('1.0.0')));
  // 缓存已落盘
  assert.ok(fs.existsSync(cacheFile()), '应写入 .last-update-check 缓存');
});

test('checkForUpdates：12h 缓存生效——缓存未过期时不再请求网络', async () => {
  resetCache();
  const cwd = tmpCwd();
  const calls = stubFetch('1.0.0');
  await checkForUpdates({ cwd, currentVersion: '1.0.0', registryUrl: 'https://stub.test/latest' });
  assert.equal(calls.calls, 1, '首次应请求');
  await checkForUpdates({ cwd, currentVersion: '1.0.0', registryUrl: 'https://stub.test/latest' });
  assert.equal(calls.calls, 1, '缓存未过期，不应再次请求');
});

test('checkForUpdates：force=true 绕过 12h 缓存', async () => {
  resetCache();
  const cwd = tmpCwd();
  const calls = stubFetch('1.0.0');
  await checkForUpdates({ cwd, currentVersion: '1.0.0', registryUrl: 'https://stub.test/latest' });
  await checkForUpdates({
    cwd,
    currentVersion: '1.0.0',
    registryUrl: 'https://stub.test/latest',
    force: true,
  });
  assert.equal(calls.calls, 2, 'force 应绕过缓存再次请求');
});

test('checkForUpdates：THATPERSON_DEV=true 直接跳过（不发网络）', async () => {
  const saved = process.env.THATPERSON_DEV;
  process.env.THATPERSON_DEV = 'true';
  try {
    const cwd = tmpCwd();
    const calls = stubFetch('1.1.0');
    await checkForUpdates({ cwd, currentVersion: '1.0.0', registryUrl: 'https://stub.test/latest' });
    assert.equal(calls.calls, 0, '开发模式不应发网络');
  } finally {
    if (saved === undefined) delete process.env.THATPERSON_DEV;
    else process.env.THATPERSON_DEV = saved;
  }
});

test('checkForUpdates：cwd 含 G:\\XXFS\\ 时正常检查（本地路径不再跳过）', async () => {
  resetCache();
  const calls = stubFetch('1.1.0');
  await checkForUpdates({
    cwd: 'G:\\XXFS\\Webstorm\\project\\ThatPerson',
    currentVersion: '1.0.0',
    registryUrl: 'https://stub.test/latest',
  });
  assert.equal(calls.calls, 1, '本地路径不应跳过，应发起网络检查');
});

test('checkForUpdates：404 静默失败（不抛错、不打印、不阻塞）', async () => {
  resetCache();
  const cwd = tmpCwd();
  const calls = stubFetch(null, 404);
  const logs = await withCapturedLog(() =>
    checkForUpdates({ cwd, currentVersion: '1.0.0', registryUrl: 'https://stub.test/latest' }),
  );
  assert.equal(calls.calls, 1);
  assert.equal(logs.length, 0, '404 不应输出任何提示');
});

test('checkForUpdates：网络错误静默失败', async () => {
  resetCache();
  const cwd = tmpCwd();
  const calls = stubFetch(null, 200, new Error('ECONNREFUSED'));
  const logs = await withCapturedLog(() =>
    checkForUpdates({ cwd, currentVersion: '1.0.0', registryUrl: 'https://stub.test/latest' }),
  );
  assert.equal(calls.calls, 1);
  assert.equal(logs.length, 0);
});

test('checkForUpdates：JSON 解析失败静默失败', async () => {
  resetCache();
  const cwd = tmpCwd();
  globalThis.fetch = async () => new Response('<html>error</html>', { status: 200 });
  const logs = await withCapturedLog(() =>
    checkForUpdates({ cwd, currentVersion: '1.0.0', registryUrl: 'https://stub.test/latest' }),
  );
  assert.equal(logs.length, 0);
});

test('checkForUpdates：版本相同不输出提示', async () => {
  resetCache();
  const cwd = tmpCwd();
  const calls = stubFetch('1.0.0');
  const logs = await withCapturedLog(() =>
    checkForUpdates({ cwd, currentVersion: '1.0.0', registryUrl: 'https://stub.test/latest' }),
  );
  assert.equal(calls.calls, 1);
  assert.equal(logs.length, 0, '版本相同不应提示更新');
});
// ===== readCurrentVersion：版本解析与工作目录解耦 =====

test('readCurrentVersion：默认从包位置解析，不依赖当前工作目录', () => {
  const saved = process.cwd();
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-nopkg-'));
  try {
    process.chdir(emptyDir); // 无 package.json 的目录
    const v = readCurrentVersion();
    assert.notEqual(v, '0.0.0', '旧行为会在无 package.json 的 cwd 下回退 0.0.0');
    assert.equal(v, realVersion);
  } finally {
    process.chdir(saved);
  }
});

test('readCurrentVersion：显式 cwd 注入仍可用（测试注入路径）', () => {
  const dir = tmpCwd();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8');
  assert.equal(readCurrentVersion(dir), '9.9.9');
});

test('checkForUpdates：当前版本取自本包，不随 cwd 漂移', async () => {
  resetCache();
  const cwd = tmpCwd();
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'other', version: '0.0.1' }), 'utf8');
  const calls = stubFetch('99.0.0');
  const logs = await withCapturedLog(() =>
    checkForUpdates({ cwd, registryUrl: 'https://stub.test/latest' }),
  );
  assert.equal(calls.calls, 1);
  assert.ok(
    logs.some((l) => l.includes('ThatPerson 新版本 99.0.0 可用') && l.includes(realVersion)),
    `应显示本包版本 ${realVersion}，而非 cwd 的 0.0.1`,
  );
});
