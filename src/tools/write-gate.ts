/**
 * 写确认闸（第 7 期批次一 · task 3b P0；KS-7.14~7.19 / DD-7.2 / DD-7.3）
 *
 * 本模块只承载写类工具集合、计划渲染与确认解析的**纯逻辑与注册点**；
 * 闸本体接线在 loop.ts 执行器段（DD-7.3：executeTool 单调用无整批视野，
 * 直接 executeTool 的既有测试不受影响）。
 *
 * 确认解析顺序（KS-7.15）：
 * ① 注入确认桩（setWriteConfirmHandler，测试用）→ ② isMock=true → 视为未确认
 * → ③ stdin TTY → inquirer y/N 一次（默认取消）→ ④ 其他非交互 → 未确认。
 *
 * 注意：本文件位于核心层（E-4 静态扫描范围），TTY 询问必须经 '../utils/ui' 动态转发，
 * 不得出现 inquirer 等渲染库字面 import。
 */
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 写类工具集合（KS-7.14）：单轮 ≥3 触发整批确认闸；move/rename 额外受结构性写单次确认约束 */
export const WRITE_CLASS_TOOLS: ReadonlySet<string> = new Set([
  'move_file',
  'rename_file',
  'create_directory',
  'write_file',
  'edit_vault_note',
  'append_memory',
  'edit_present',
]);

/** 是否写类工具（读类/danger 不计入确认闸阈值） */
export function isWriteClass(name: string): boolean {
  return WRITE_CLASS_TOOLS.has(name);
}

/** 一条写计划：源 → 目标（渲染计划清单用） */
export interface WritePlanEntry {
  tool: string;
  source: string;
  target: string;
}

/** 写计划：batch = 单轮写类 ≥3 的整批确认；structural = move/rename 目标在 home 外的单次确认 */
export interface WritePlan {
  kind: 'batch' | 'structural';
  entries: WritePlanEntry[];
}

/** 确认桩签名：返回 true = 批准执行；false = 拒绝（整批回灌 confirm-required 提案） */
export type WriteConfirmHandler = (plan: WritePlan) => boolean | Promise<boolean>;

let confirmHandler: WriteConfirmHandler | null = null;

/** 注入确认桩（测试用）；传 null 恢复默认解析顺序 */
export function setWriteConfirmHandler(handler: WriteConfirmHandler | null): void {
  confirmHandler = handler;
}

/** 读取当前确认桩（loop 接线消费；无桩返回 null） */
export function getWriteConfirmHandler(): WriteConfirmHandler | null {
  return confirmHandler;
}

/** 测试专用别名（e2e/回归注入同一桩；与 setWriteConfirmHandler 等价，便于语义区分） */
export function setWriteGateConfirmForTest(handler: WriteConfirmHandler | null): void {
  confirmHandler = handler;
}

/**
 * 渲染计划清单（源 → 目标，逐行）；供 confirm-required 的 reason 回灌给模型（KS-7.15）。
 * 只供回灌/弹窗，不落盘（W-8 双口径：磁盘审计行由 loop 脱敏）。
 * 纯函数，无状态。
 */
export function renderWritePlan(plan: WritePlan): string {
  const header =
    plan.kind === 'batch'
      ? `批量写入计划（共 ${plan.entries.length} 项，需确认）`
      : '结构性写入计划（需确认）';
  const lines = plan.entries.map((e) => `- [${e.tool}] ${e.source || '（新内容）'} → ${e.target}`);
  return [header, ...lines].join('\n');
}

/** 从 args 提取字符串参数（无该键返回空串） */
function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

/** append_memory 归档类型 → history 落点（与 builtin.ts MEMORY_TYPE_TARGETS 语义一致，只记相对位置） */
const MEMORY_TARGETS: Record<string, string> = {
  偏好: 'history/profile/preferences.md',
  身份: 'history/profile/identity.md',
  经历: 'history/experiences/journal.md',
  日期: 'history/timeline/important_dates.md',
};

/** 单个写类调用 → 计划条目（源 → 目标；move/rename 取最终落点，其余取目标路径/相对位置） */
export function planEntryOf(name: string, args: Record<string, unknown>): WritePlanEntry {
  switch (name) {
    case 'move_file': {
      const source = argStr(args, 'source');
      const targetDir = argStr(args, 'targetDir');
      return {
        tool: name,
        source,
        target: targetDir ? path.join(targetDir, path.basename(source)) : targetDir,
      };
    }
    case 'rename_file': {
      const source = argStr(args, 'source');
      const newName = argStr(args, 'newName');
      return { tool: name, source, target: source ? path.join(path.dirname(source), newName) : newName };
    }
    case 'create_directory':
      return { tool: name, source: '', target: argStr(args, 'path') };
    case 'write_file':
      return { tool: name, source: '', target: argStr(args, 'path') };
    case 'edit_vault_note':
      return { tool: name, source: '', target: argStr(args, 'file') };
    case 'edit_present':
      return { tool: name, source: '', target: argStr(args, 'file') };
    case 'append_memory': {
      const type = argStr(args, 'type');
      return { tool: name, source: '', target: MEMORY_TARGETS[type] ?? 'history/（按类型归档）' };
    }
    default:
      return { tool: name, source: '', target: '' };
  }
}

/** 带参数的调用输入（loop 侧传 name + arguments 原文；本模块负责安全解析） */
export interface PlanCallInput {
  name: string;
  arguments: string;
}

/** 从一轮 toolCalls 构建写计划（只取写类调用；JSON 解析失败按空参数兜底，不抛错） */
export function buildWritePlan(calls: PlanCallInput[], kind: WritePlan['kind']): WritePlan {
  const entries: WritePlanEntry[] = [];
  for (const call of calls) {
    if (!isWriteClass(call.name)) continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.arguments);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // 参数解析失败按空参数渲染计划（闸仍拦截，回灌失败信封由 loop 负责）
    }
    entries.push(planEntryOf(call.name, args));
  }
  return { kind, entries };
}

/** 渲染整批计划清单（KS-7.15；只供回灌/弹窗，不落盘） */
export function renderBatchPlan(calls: PlanCallInput[]): string {
  return renderWritePlan(buildWritePlan(calls, 'batch'));
}

/** 结构性写的目标目录：move_file → targetDir；rename_file → 源所在目录；其余 null */
export function structuralTargetDirOf(name: string, args: Record<string, unknown>): string | null {
  if (name === 'move_file') {
    const dir = argStr(args, 'targetDir');
    return dir || null;
  }
  if (name === 'rename_file') {
    const source = argStr(args, 'source');
    return source ? path.dirname(source) : null;
  }
  return null;
}

/** 判断目录是否在 home 之外（KS-7.16：home 外的结构性写需单次确认；home 内不确认） */
export function isOutsideHome(dir: string, home: string): boolean {
  try {
    const rel = path.relative(path.resolve(home), path.resolve(dir));
    if (!rel || rel === '') return false; // 同目录
    return rel.startsWith('..') || path.isAbsolute(rel);
  } catch {
    return true; // 解析失败按保守处理：视为 home 外
  }
}

/**
 * 确认解析（KS-7.15 顺序）：
 * ① 注入确认桩 → 直接采信桩结果；② isMock=true → 未确认；
 * ③ stdin TTY → inquirer confirm（默认取消）一次；④ 其他非交互 → 未确认。
 */
export async function resolveWriteConfirm(
  plan: WritePlan,
  opts: { isMock: boolean; isTTY: boolean },
): Promise<boolean> {
  if (confirmHandler) {
    return (await confirmHandler(plan)) === true;
  }
  if (opts.isMock) return false;
  if (opts.isTTY) {
    // 经表现层转发（避免核心层出现渲染库字面 import；inquirer confirm 缺省即取消）
    const { ask } = await import('../utils/ui');
    const answer = await ask(`${renderWritePlan(plan)}\n是否执行以上写操作？`, 'confirm');
    return answer === true;
  }
  return false;
}

/** 目标目录隐私摘要（KS-7.18）：sha256 前 12 位 hex，审计行不含明文路径 */
export function targetDirKeyOf(dir: string): string {
  return createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12);
}
