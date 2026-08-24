/**
 * 更新自动检查（第 4 期 · S-07 / S-08）
 *
 * - 读 package.json version（opts.cwd 供测试注入）；
 * - 向 scoped 包 registry 查询（https://registry.npmjs.org/@nineteenfolk%2fthatperson/latest）；
 * - 仅当 latest > current（数字分段比较，避免引入 semver 依赖）时输出更新提示；
 * - 12h 缓存落 thatPersonHome()/.last-update-check（支持 THATPERSON_HOME 重定向，与 IS-1~3 隔离口径一致）；
 * - THATPERSON_DEV=true 时跳过（显式开发模式）；本地路径不再豁免，已安装用户可正常检查更新；
 * - 404 / 网络错误 / 超时 / JSON 解析失败 / 缓存写失败：全部静默返回，不打印、不阻塞启动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { thatPersonHome } from '../config';

/** 官方 registry 最新版接口（scoped 包名需 URL 编码 @ 与 /：@nineteenfolk%2fthatperson） */
export const REGISTRY_URL = 'https://registry.npmjs.org/@nineteenfolk%2fthatperson/latest';
/** 12 小时缓存窗口 */
export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** 缓存文件名（落 thatPersonHome()） */
export const UPDATE_CACHE_FILE = '.last-update-check';

export interface UpdateCheckOptions {
  /** 手动触发：绕过 12h 缓存（跳过策略仍生效） */
  force?: boolean;
  /** 项目目录（测试注入；读 package.json version / 跳过策略判定用） */
  cwd?: string;
  /** 测试注入：当前版本（缺省从 cwd/package.json 读取） */
  currentVersion?: string;
  /** 测试注入：registry 地址（缺省官方地址） */
  registryUrl?: string;
  /** 测试注入：当前时间戳（缓存过期判定用） */
  now?: number;
}

/**
 * 数字分段版本比较：latest 比 current 新返回 true。
 * 逐段比较数字（如 1.10.0 > 1.9.0），缺失段按 0 处理，非法段按 0 处理。
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    String(v)
      .split('.')
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isNaN(n) ? 0 : n;
      });
  const a = parse(latest);
  const b = parse(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** 读取本包 package.json 的 version；缺失/损坏时回退 '0.0.0'。
 *  默认从包安装位置解析（dist/src/utils 上溯 3 级到包根），而非 process.cwd()，
 *  保证 --version / 横幅 / status 卡片在任意工作目录下都显示本包版本。 */
export function readCurrentVersion(cwd?: string): string {
  const base = cwd ?? path.join(__dirname, '..', '..', '..');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 跳过策略（S-08 修订）：仅 THATPERSON_DEV=true 时跳过；cwd 不再参与判断（本地路径可正常检查） */
export function shouldSkipUpdateCheck(cwd = process.cwd()): boolean {
  if (process.env.THATPERSON_DEV === 'true') return true;
  return false;
}

/** 缓存是否过期：无文件 / 解析失败 / 距今 ≥12h → 需要检查 */
export function isUpdateCacheExpired(cacheFile: string, now: number): boolean {
  try {
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const lastCheck = Number.parseInt(raw, 10);
    if (Number.isNaN(lastCheck)) return true;
    return now - lastCheck >= UPDATE_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

/** 记录本次检查时间（目录不存在则递归创建） */
export function recordUpdateCheck(cacheFile: string, now: number): void {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, String(now), 'utf8');
}

/** 查询 registry 最新版；404 / 网络错误 / 超时 / JSON 解析失败一律返回 null */
async function fetchLatestVersion(registryUrl: string): Promise<string | null> {
  try {
    const res = await fetch(registryUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === 'string' && data.version ? data.version : null;
  } catch {
    return null;
  }
}

/**
 * 更新检查主入口（S-07/S-08）。
 * - force=false：12h 缓存未过期则直接返回；force=true：绕过缓存，跳过策略仍生效。
 * - 记录检查时间在查询之前（参考代码口径）：即使网络失败，12h 内也不再重试。
 */
export async function checkForUpdates(opts: UpdateCheckOptions = {}): Promise<void> {
  const { force = false, cwd = process.cwd(), now = Date.now() } = opts;
  if (shouldSkipUpdateCheck(cwd)) return;
  const current = opts.currentVersion ?? readCurrentVersion();
  const cacheFile = path.join(thatPersonHome(), UPDATE_CACHE_FILE);
  if (!force && !isUpdateCacheExpired(cacheFile, now)) return;
  try {
    recordUpdateCheck(cacheFile, now);
  } catch {
    return; // 缓存写失败：静默返回
  }
  const latest = await fetchLatestVersion(opts.registryUrl ?? REGISTRY_URL);
  if (!latest) return;
  if (isNewerVersion(latest, current)) {
    console.log(`✨ ThatPerson 新版本 ${latest} 可用！当前 ${current}。升级：npm install -g @nineteenfolk/thatperson@latest`);
  }
}
