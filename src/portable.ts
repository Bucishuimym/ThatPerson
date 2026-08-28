/**
 * 记忆可携带：export / import（第 6 期 · KS-45~KS-46；批次三 D-3 预研）
 *
 * 预研范围（批次二 PASS 前）：接口签名 + 纯函数实现，编译通过；接线进 cli.ts 留后。
 *
 * 红线：
 * - export 不落 Key 明文（config 只导出脱敏掩码，apiKey 一律 sk-***xxxx）；
 * - import 不写 Key（config.json / 含 api-key 命名的文件一律跳过，永不落盘）；
 * - 导出范围仅记忆资产（history / present / skills）。
 *
 * 零依赖：node:fs 递归拷贝 + node:crypto sha256，不引入 zip/tar 库。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 导出包格式版本：import 校验版本匹配用 */
export const MANIFEST_VERSION = '1';

/** 导出包 manifest：版本 / 日期 / 源路径 / 清单校验和 */
export interface Manifest {
  version: string;
  exportedAt: string;
  sourceRoot: string;
  entries: { path: string; checksum: string }[];
}

export interface ExportMemoryOptions {
  /** 源主目录（写入 manifest.sourceRoot） */
  home: string;
  /** 记忆目录（history 所在目录，实际存储位置） */
  historyDir: string;
  /** 导出包目标父目录（包名 thatperson-export-<YYYYMMDD_HHmmss>/） */
  targetDir: string;
  /** present 源目录（缺省 home/present） */
  presentDir?: string;
  /** 用户级 skills 源目录（缺省 home/skills） */
  skillsDir?: string;
  /** 只导出脱敏掩码：apiKey 永不明文，其他键透传 */
  configMask?: Record<string, unknown>;
  /** 注入时间（可测）；缺省 new Date() */
  now?: Date;
}

export interface ExportMemoryResult {
  exportRoot: string;
  manifest: Manifest;
}

export interface ImportMemoryOptions {
  home: string;
  historyDir: string;
  exportDir: string;
}

export interface ImportMemoryResult {
  imported: number;
  conflicts: string[];
}

/** 需要永不明文落盘的键（大小写不敏感） */
const SECRET_KEY_RE = /api\s*[-_]?key/i;
/** 敏感资产：永不参与导入（Key / 配置文件 / 环境变量） */
const SENSITIVE_ASSET_RE = /(^|\/)(config\.json|\.env|.*api[-_]?key.*)$/i;

/** 记忆资产前缀 → 导入目标根 */
type AssetRoot = 'history' | 'present' | 'skills';

/** YYYYMMDD_HHmmss */
function formatStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Key 掩码（对齐 config.ts maskApiKey 口径）：仅保留末 4 位，如 sk-***abcd；
 * 空串 / 尾数不足 4 位时统一 sk-***。
 */
export function maskSecret(key: string): string {
  const clean = key.trim();
  if (!clean) return '';
  const tail = clean.slice(-4);
  return `sk-***${tail.length === 4 ? tail : ''}`;
}

/** sha256 校验和（hex） */
export function computeChecksum(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** 递归拷贝目录并收集 manifest entries（相对路径统一正斜杠，便于跨平台校验） */
function copyTree(
  srcDir: string,
  destDir: string,
  relPrefix: string,
  entries: Manifest['entries'],
): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const rel = path.join(relPrefix, entry.name);
    if (entry.isDirectory()) {
      copyTree(srcPath, path.join(destDir, entry.name), rel, entries);
    } else if (entry.isFile()) {
      const destPath = path.join(destDir, entry.name);
      fs.copyFileSync(srcPath, destPath);
      entries.push({ path: rel.split(path.sep).join('/'), checksum: computeChecksum(destPath) });
    }
  }
}

/** config 只导出脱敏掩码：apiKey 一律 maskSecret，其他键透传 */
function maskConfig(configMask: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(configMask)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = typeof value === 'string' && value ? maskSecret(value) : '';
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 导出记忆：零依赖递归复制 history / present / skills → targetDir/thatperson-export-<ts>/，
 * 写 manifest.json；config 只导出脱敏掩码（apiKey 永不明文）。
 */
export function exportMemory(opts: ExportMemoryOptions): ExportMemoryResult {
  const now = opts.now ?? new Date();
  const exportRoot = path.join(opts.targetDir, `thatperson-export-${formatStamp(now)}`);
  fs.mkdirSync(exportRoot, { recursive: true });

  const sources: Array<[AssetRoot, string]> = [
    ['history', opts.historyDir],
    ['present', opts.presentDir ?? path.join(opts.home, 'present')],
    ['skills', opts.skillsDir ?? path.join(opts.home, 'skills')],
  ];
  const entries: Manifest['entries'] = [];
  for (const [rel, src] of sources) {
    if (!fs.existsSync(src)) continue;
    copyTree(src, path.join(exportRoot, rel), rel, entries);
  }

  // config 只导出脱敏掩码（masked config.json 属导出包的配置说明，不进入 manifest entries，
  // import 永不消费它——Key 永不跨机器）
  if (opts.configMask) {
    const masked = maskConfig(opts.configMask);
    fs.writeFileSync(path.join(exportRoot, 'config.json'), `${JSON.stringify(masked, null, 2)}\n`, 'utf8');
  }

  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    exportedAt: now.toISOString(),
    sourceRoot: opts.home,
    entries,
  };
  fs.writeFileSync(path.join(exportRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { exportRoot, manifest };
}

/** 校验 manifest：全部 entries 存在且 checksum 一致（任一失败返回 false） */
export function verifyManifest(exportDir: string, manifest: Manifest): boolean {
  try {
    for (const entry of manifest.entries) {
      const p = path.join(exportDir, entry.path);
      if (!fs.existsSync(p)) return false;
      if (computeChecksum(p) !== entry.checksum) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** manifest 相对路径 → 本地目标路径（仅记忆资产范围；越界 / 敏感文件返回 null） */
function resolveImportTarget(rel: string, home: string, historyDir: string): string | null {
  const parts = rel.split('/');
  if (parts.length === 0 || parts.some((p) => p === '..' || p === '')) return null;
  const root = parts[0] as AssetRoot;
  const rest = parts.slice(1).join(path.sep);
  if (!rest) return null;
  switch (root) {
    case 'history':
      return path.join(historyDir, rest);
    case 'present':
      return path.join(home, 'present', rest);
    case 'skills':
      return path.join(home, 'skills', rest);
    default:
      return null;
  }
}

/**
 * 合并导出包到本地：先校验 manifest（version 匹配 + checksum 复核），
 * 同名冲突先备份到 historyDir/backups/<时间戳>/ 再合并（不静默覆盖）；
 * 永不导入 Key / config。
 */
export function importMemory(opts: ImportMemoryOptions): ImportMemoryResult {
  const manifestPath = path.join(opts.exportDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`导出包缺少 manifest.json：${opts.exportDir}`);
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch {
    throw new Error('manifest.json 无法解析，导入中止（拒绝静默覆盖）');
  }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(`版本不匹配：导出包 ${manifest.version}，当前支持 ${MANIFEST_VERSION}`);
  }
  if (!verifyManifest(opts.exportDir, manifest)) {
    throw new Error('校验和复核未通过，导入中止（导出包可能已损坏）');
  }

  const backupStamp = formatStamp(new Date());
  let imported = 0;
  const conflicts: string[] = [];
  for (const entry of manifest.entries) {
    const rel = entry.path;
    if (SENSITIVE_ASSET_RE.test(rel)) continue; // 不导入 Key / 配置（红线）
    const target = resolveImportTarget(rel, opts.home, opts.historyDir);
    if (!target) continue; // 仅合并记忆资产范围
    const srcPath = path.join(opts.exportDir, rel);
    if (!fs.existsSync(srcPath)) continue; // verifyManifest 已兜底，此处双保险
    if (fs.existsSync(target)) {
      const backup = path.join(opts.historyDir, 'backups', backupStamp, rel);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(target, backup);
      conflicts.push(rel);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(srcPath, target);
    imported += 1;
  }
  return { imported, conflicts };
}
