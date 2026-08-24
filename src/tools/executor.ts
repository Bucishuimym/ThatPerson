/**
 * 工具执行器（第 5 期批次二 · KS-18）
 *
 * 统一入口：注册检查 → 权限门（danger 双门控）→ 参数校验 → handler → 结果截断；
 * handler 抛错一律捕获为 { ok:false, error }，不让异常泄漏到 ReAct 循环。
 */
import { getTool } from './registry';
import { RESULT_CHAR_LIMIT, truncateResult, validateParams } from './guards';
import type { ToolContext, ToolResult } from './types';

/** 工具执行选项：dangerAllowed=false 时 danger 策略工具一律拒绝 */
export interface ExecuteToolOptions {
  dangerAllowed?: boolean;
}

/**
 * 执行工具：
 * - 未注册 → { ok:false, error:'unknown-tool' }；
 * - danger 且未授权 → { ok:false, error:'danger-disabled' }；
 * - 参数校验失败 → 返回校验错误；
 * - handler 抛错 → 捕获为 { ok:false, error }；
 * - 成功结果 → truncateResult 截断（上限 RESULT_CHAR_LIMIT）。
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  opts: ExecuteToolOptions = {},
): Promise<ToolResult> {
  const def = getTool(name);
  if (!def) return { ok: false, error: 'unknown-tool' };
  if (def.policy === 'danger' && opts.dangerAllowed !== true) {
    return { ok: false, error: 'danger-disabled' };
  }
  const checked = validateParams(def, args);
  if (!checked.ok) return { ok: false, error: checked.error };
  try {
    const result = await def.handler(checked.clean, ctx);
    if (!result.ok) return result;
    return { ok: true, content: truncateResult(result.content, RESULT_CHAR_LIMIT) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.slice(0, 500) };
  }
}
