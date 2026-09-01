/**
 * 工具执行器（第 5 期批次二 · KS-18；第 6 期批次二 · KS-35 结构化拒绝 / KS-39 allow-dir 即时生效）
 *
 * 统一入口：注册检查 → 权限门（danger 双门控）→ 参数校验 → handler → 结果截断；
 * 失败统一升级为结构化信封 { ok:false, error, code, riskLevel, reason, unlockHint }；
 * handler 抛错一律捕获，不让异常泄漏到 ReAct 循环。
 */
import path from 'node:path';
import { getTool } from './registry';
import { RESULT_CHAR_LIMIT, truncateResult, validateParams } from './guards';
import { loadConfig } from '../config';
import type { RiskLevel, ToolContext, ToolFailure, ToolResult } from './types';

/** 工具执行选项：dangerAllowed=false 时 danger 策略工具一律拒绝 */
export interface ExecuteToolOptions {
  dangerAllowed?: boolean;
}

/** 路径拒绝解锁提示（KS-39：字面占位文案，不回显实际被拒路径 / home 根） */
const PATH_DENIED_HINT = '该路径不在允许目录内；如需访问请运行 thatperson allow-dir <路径> 授权后重试';
/** L3 命令执行解锁提示（KS-36） */
const DANGER_DISABLED_HINT = '高危操作，需你：① 设 THATPERSON_ENABLE_SHELL=true ② 逐次确认；也可先做静态检查由你手动执行';
/** 写确认闸解锁提示（第 7 期 KS-7.25：不含任何路径/home 根） */
export const CONFIRM_REQUIRED_HINT =
  '在交互终端重试并在提示时确认；或改为单文件操作';

/** 兜底风险等级：未标注时 danger 按 L3、其余按 L0 */
function riskOf(def: { policy: string; riskLevel?: RiskLevel }): RiskLevel {
  if (def.riskLevel) return def.riskLevel;
  return def.policy === 'danger' ? 'L3' : 'L0';
}

/** 参数类错误前缀（KS-35：'keyword-empty'/'missing-oldValue' 等 → param-invalid） */
const PARAM_ERROR_PREFIXES = [
  'keyword-empty',
  'insight-empty',
  'missing-oldValue',
  'param-invalid',
  'path 与 date 只能二选一',
  '需要 path 或 date 参数',
  'invalid-date',
  'not-a-note',
  'not-a-file',
  'not-a-directory',
  'file-not-in-whitelist',
  'unknown-type:',
];

/**
 * 把 handler 的简式错误升级为结构化失败信封（KS-35）：
 * code 前缀映射——path-denied/path-not-allowed→path-denied；conflict→conflict；
 * redline-denied→redline-denied；source-not-found/not-found→not-found；
 * keyword-empty/missing-oldValue 等→param-invalid；其余→other。
 * error 字段保留原字符串（向后兼容既有测试）。
 */
function buildFailure(error: string, riskLevel: RiskLevel): ToolFailure {
  const e = error || 'unknown-error';
  if (e === 'unknown-tool') {
    return { ok: false, error: e, code: 'unknown-tool', riskLevel, reason: '该工具未注册，不可调用', unlockHint: '' };
  }
  if (e === 'danger-disabled') {
    return { ok: false, error: e, code: 'danger-disabled', riskLevel, reason: '危险操作未获用户授权', unlockHint: DANGER_DISABLED_HINT };
  }
  if (e.startsWith('path-denied') || e.startsWith('path-not-allowed')) {
    return { ok: false, error: e, code: 'path-denied', riskLevel, reason: '路径不在允许目录内', unlockHint: PATH_DENIED_HINT };
  }
  if (e.startsWith('redline-denied')) {
    return { ok: false, error: e, code: 'redline-denied', riskLevel, reason: '该文件为敏感红线文件，永远拒绝编辑', unlockHint: '' };
  }
  if (e.startsWith('confirm-required')) {
    // 第 7 期 KS-7.25：写确认闸拒绝（批量/结构性写未获用户确认）；unlockHint 不含任何路径
    return {
      ok: false,
      error: e,
      code: 'confirm-required',
      riskLevel,
      reason: '需要用户确认的写操作未获确认',
      unlockHint: CONFIRM_REQUIRED_HINT,
    };
  }
  if (e.startsWith('conflict')) {
    return { ok: false, error: e, code: 'conflict', riskLevel, reason: '目标已存在，拒绝覆盖', unlockHint: '可用 append 追加，或先移除旧文件后再试' };
  }
  if (/not-found/.test(e)) {
    return { ok: false, error: e, code: 'not-found', riskLevel, reason: '源文件或目标不存在', unlockHint: '' };
  }
  if (PARAM_ERROR_PREFIXES.some((prefix) => e.startsWith(prefix))) {
    return { ok: false, error: e, code: 'param-invalid', riskLevel, reason: '参数校验未通过', unlockHint: '' };
  }
  return { ok: false, error: e, code: 'other', riskLevel, reason: '工具执行出错', unlockHint: '' };
}

/**
 * 执行工具：
 * - 未注册 → 失败信封 code:'unknown-tool'（error 保留 'unknown-tool'）；
 * - danger 且未授权 → code:'danger-disabled'；
 * - 参数校验失败 → code:'param-invalid'；
 * - handler 抛错 → 捕获并映射 code；
 * - allow-dir 即时生效：调用 handler 前把 loadConfig().allowedDirs 合并进 ctx.allowedRoots；
 * - 成功结果 → truncateResult 截断（上限 RESULT_CHAR_LIMIT）。
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  opts: ExecuteToolOptions = {},
): Promise<ToolResult> {
  const def = getTool(name);
  if (!def) return buildFailure('unknown-tool', 'L0');
  const riskLevel = riskOf(def);
  if (def.policy === 'danger' && opts.dangerAllowed !== true) {
    return buildFailure('danger-disabled', riskLevel);
  }
  const checked = validateParams(def, args);
  if (!checked.ok) {
    return { ok: false, error: checked.error, code: 'param-invalid', riskLevel, reason: '参数校验未通过', unlockHint: '' };
  }
  // KS-39：授权目录即时生效——授权后同 ctx 重试即命中（无需重启）
  const configRoots = (loadConfig().allowedDirs ?? []).map((p) => path.resolve(p));
  const handlerCtx: ToolContext = {
    ...ctx,
    allowedRoots: [...new Set([...(ctx.allowedRoots ?? []).map((p) => path.resolve(p)), ...configRoots])],
  };
  try {
    const result = await def.handler(checked.clean, handlerCtx);
    if (!result.ok) return buildFailure(result.error, riskLevel);
    return { ok: true, content: truncateResult(result.content, RESULT_CHAR_LIMIT) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildFailure(message.slice(0, 500), riskLevel);
  }
}
