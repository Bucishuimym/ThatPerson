/**
 * 工具层守卫（第 5 期批次二 · KS-18）
 *
 * - validateParams：按 params 声明做类型/必填/enum 校验，未知参数忽略；
 * - assertPathAllowed：目录白名单校验（拒绝 `..` 逃逸、盘符混用、符号链接逃逸）；
 * - truncateResult：结果统一截断，防止超长内容挤占上下文（SEC-11 边界收敛）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDef } from './types';

/** 读取环境变量整数（缺失/非法回退默认值；供限制类常量可配置化） */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 工具结果最大字符数（超长截断；THATPERSON_RESULT_CHAR_LIMIT 可调，默认 16000） */
export const RESULT_CHAR_LIMIT = envInt('THATPERSON_RESULT_CHAR_LIMIT', 16000);

/** 截断后缀（含省略号） */
const TRUNCATE_SUFFIX = '…[已截断]';

/**
 * 按 params 声明校验并清洗参数：
 * - 必填缺失 / 类型不符 / enum 越界 → { ok:false, error }；
 * - 未知参数忽略（不进入 clean，防模型注入多余键）。
 */
export function validateParams(
  def: ToolDef,
  args: Record<string, unknown>,
): { ok: true; clean: Record<string, unknown> } | { ok: false; error: string } {
  const clean: Record<string, unknown> = {};
  for (const param of def.params) {
    const value = args[param.name];
    if (value === undefined || value === null) {
      if (param.required) {
        return { ok: false, error: `缺少必填参数：${param.name}` };
      }
      continue;
    }
    if (param.type === 'string') {
      if (typeof value !== 'string') {
        return { ok: false, error: `参数 ${param.name} 类型错误：应为 string，实际为 ${typeof value}` };
      }
      if (param.enum && !param.enum.includes(value)) {
        return { ok: false, error: `参数 ${param.name} 取值不合法，允许：${param.enum.join(' / ')}` };
      }
    } else if (param.type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return { ok: false, error: `参数 ${param.name} 类型错误：应为 number` };
      }
    } else if (param.type === 'boolean') {
      if (typeof value !== 'boolean') {
        return { ok: false, error: `参数 ${param.name} 类型错误：应为 boolean` };
      }
    }
    clean[param.name] = value;
  }
  return { ok: true, clean };
}

const isWindows = process.platform === 'win32';

/** 大小写归一（Windows 路径比较必须忽略大小写） */
function norm(p: string): string {
  return isWindows ? p.toLowerCase() : p;
}

/**
 * 目录白名单校验：
 * 1) path.resolve 解析（处理相对路径）；
 * 2) 显式盘符与解析结果盘符不一致（跨盘混用）直接拒绝；
 * 3) 已存在路径 fs.realpathSync 后复检前缀（防符号链接逃逸）；
 * 4) 不存在路径按 resolve 结果校验前缀。
 * 合法返回安全绝对路径，非法返回 null。
 */
export function assertPathAllowed(rawPath: string, allowedRoots: string[]): string | null {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return null;
  if (rawPath.includes('\0')) return null;

  const resolved = path.resolve(rawPath);
  // 盘符混用：rawPath 显式带盘符时，其解析结果必须落在同一盘符上
  const driveMatch = /^([a-zA-Z]):/.exec(rawPath.trim());
  if (driveMatch && isWindows) {
    const resolvedRoot = path.parse(resolved).root;
    const resolvedDrive = /^([a-zA-Z]):/.exec(resolvedRoot)?.[1]?.toLowerCase();
    if (resolvedDrive && resolvedDrive !== driveMatch[1].toLowerCase()) {
      return null;
    }
  }

  // 已存在路径：realpath 复检（解析符号链接后再做前缀校验）；不存在路径直接校验 resolve 结果
  let safePath: string;
  try {
    safePath = fs.realpathSync(resolved);
  } catch {
    safePath = resolved;
  }

  for (const root of allowedRoots) {
    if (typeof root !== 'string' || root.trim() === '') continue;
    const rootAbs = path.resolve(root);
    const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
    if (norm(safePath) === norm(rootAbs) || norm(safePath).startsWith(norm(prefix))) {
      return safePath;
    }
  }
  return null;
}

/** 结果截断：超长时保留前部并追加截断标记（默认 RESULT_CHAR_LIMIT） */
export function truncateResult(content: string, max: number = RESULT_CHAR_LIMIT): string {
  if (content.length <= max) return content;
  const keep = Math.max(0, max - TRUNCATE_SUFFIX.length);
  return content.slice(0, keep) + TRUNCATE_SUFFIX;
}
