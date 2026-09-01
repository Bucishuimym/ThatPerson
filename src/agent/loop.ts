/**
 * ReAct 循环（第 5 期批次二 · KS-20；第 6 期批次二 · KS-36 卡点诊断 / KS-38 审计 / KS-39 allow-dir / KS-41 TTY 确认；
 * 第 7 期批次一 · KS-7.15~7.18 写确认闸与审计增强 / 会话事件协议发射点）
 *
 * 三段结构：解析（chat() 返回 toolCalls）→ 执行（executeTool，danger 默认禁用）
 * → 回灌（tool 结果拼进 messages 再调 chat()），循环直到无 toolCalls 或达 MAX_TOOL_ITERATIONS。
 *
 * 安全约束：
 * - 审计日志只记参数键名（argsKeys），绝不记录参数值 / API Key；写入失败静默；
 *   W-8 双口径：内存 toolLog.reason 可含整批计划全文（回灌模型用），磁盘审计行一律脱敏
 *   （计划明细 → 泛化文案 + count/targetDirKey 元数据，不含明文路径）；
 * - 路径白名单 ctx.allowedRoots = [home, cwd, cwd/.thatperson, THATPERSON_VAULT_ROOT]；
 * - 连续失败 3 次 → 卡点诊断模板（含等级/守卫/解锁，消灭「我做不到」）并终止；
 * - 结构化失败信封（code/riskLevel/reason/unlockHint）回灌给模型；
 * - 审计日志补记 riskLevel 与 decision（allowed / denied / allowed-confirmed）；
 * - TTY 确认：非 --mock 且 stdin 为 TTY 时，首次 path-denied 弹一次确认；非交互/管道/--mock 一律不弹不自动授权；
 * - 写确认闸（KS-7.15，DD-7.3：闸在执行器段而非 executeTool 单调用层）：
 *   单轮写类 ≥3 → 整批计划确认（拒绝=整批回灌 confirm-required 不执行；批准=逐条执行审计 allowed-confirmed）；
 *   move/rename 目标在 home 外 → 执行前单次确认（isMock 未确认=结构化拒绝）；
 * - --mock 路径完全不调用 chat()/API：首轮返回（离线演示）回复，支持通过
 *   THATPERSON_MOCK_TOOL_CALLS（JSON）注入工具调用以便测试三段可测。
 *
 * 事件发射（会话事件协议 v1.0；无 sink 时输出与现状逐字节等价）：
 * - agent_start（循环启动）/ status start·end（rounds）；
 * - tool_call（每调用前：name/argsKeys/policy/riskLevel）/ tool_result（每调用后：name/ok/code/ms/riskLevel）；
 * - memory_write（写类工具成功）/ error（结构化失败，message 不含 Key/明文路径）；
 * - 第 7 期批次三 T10：tool_call/tool_result/memory_write 按操作路径归属挂载根——
 *   resolve 后命中 vaultRoot()/config.allowedDirs 之一则带 vaultId（根名），无命中省略字段；
 * - 第 7 期批次三 T11b：执行器段捕获本轮成功读类工具结果内容（≤4000 字符/条）随
 *   readContents/readResults 导出（只走沉淀提案通道，绝不直接归档），写类目标随 writeTargets 导出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chat, type ChatMessage, type ChatOptions, type ChatResult, type ToolCall } from '../chat';
import { loadConfig, memoryRoot } from '../config';
import { emitEvent } from '../events';
import { CONFIRM_REQUIRED_HINT, executeTool } from '../tools/executor';
import { envInt } from '../tools/guards';
import { getTool } from '../tools/registry';
import { vaultRoot } from '../vault';
import {
  buildWritePlan,
  isOutsideHome,
  isWriteClass,
  planEntryOf,
  renderWritePlan,
  resolveWriteConfirm,
  structuralTargetDirOf,
  targetDirKeyOf,
  type WritePlan,
} from '../tools/write-gate';
import type { ToolContext, ToolDef, ToolFailure, ToolResult } from '../tools/types';
import type { LoadedMemories } from '../memory/types';

/** 单轮最多执行的工具调用轮次（THATPERSON_MAX_TOOL_ITERATIONS 可调，默认 12） */
export const MAX_TOOL_ITERATIONS = envInt('THATPERSON_MAX_TOOL_ITERATIONS', 12);
/** 连续失败阈值：达到即认输 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** 整批写确认闸阈值（KS-7.15）：单轮写类 ≥3 触发 */
const WRITE_GATE_THRESHOLD = 3;
/** 卡点守卫命名（KS-36：按 code 对应守卫名） */
function guardName(code: string): string {
  switch (code) {
    case 'path-denied':
      return '路径白名单守卫';
    case 'danger-disabled':
      return '权限门';
    case 'param-invalid':
      return '参数校验守卫';
    case 'conflict':
      return '写冲突守卫';
    case 'redline-denied':
      return '红线守卫';
    case 'not-found':
      return '资源定位守卫';
    case 'unknown-tool':
      return '注册表守卫';
    case 'io-error':
      return 'IO 守卫';
    case 'confirm-required':
      return '写确认闸';
    default:
      return '执行守卫';
  }
}

/** 卡点诊断模板（KS-36：含步骤/等级/守卫/解锁动作；解锁为空时输出「无自动解锁路径」；不含「我做不到」） */
function formatGiveUp(step: number, tool: string, failure: ToolFailure): string {
  const hint = failure.unlockHint && failure.unlockHint.trim() ? failure.unlockHint : '无自动解锁路径';
  return (
    `卡点诊断：第${step}步 · 工具「${tool}」被 ${guardName(failure.code)} 拦截` +
    `（等级 ${failure.riskLevel}）：${failure.reason}。解锁动作：${hint}。`
  );
}
/** 达上限收尾说明 */
const MAX_ITERATION_NOTE = '\n\n（已达工具调用轮次上限，本次先到这里；如需继续，请再说一次。）';
/** mock 回复前缀 */
const MOCK_REPLY_PREFIX = '（离线演示）';

/** 读类工具集合（T11b 沉淀候选来源；与 sediment.ts READ_TOOLS 一致） */
const READ_CLASS_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'read_vault_note',
  'search_vault',
  'search_memory',
  'vault_search',
]);

/** 读类工具结果捕获上限（字符/条） */
const READ_CONTENT_LIMIT = 4000;

/** 结构化读类结果（T11b：tool+path 供提案 evidence 与工具活动统计，content 只走提案通道） */
export interface LoopReadResult {
  tool: string;
  path: string;
  content: string;
}

/** 工具调用审计日志条目（只含参数键名，绝不含参数值 / Key；KS-38 补记 riskLevel 与 decision；
 *  第 7 期 KS-7.18：move/rename 行补 count（本轮写类条数）与 targetDirKey（sha256 前 12 位 hex，无明文路径）） */
export interface ToolLogEntry {
  ts: string;
  tool: string;
  argsKeys: string[];
  status: 'ok' | 'error' | 'danger-blocked' | 'unknown';
  ms: number;
  /** 风险等级（L0~L3） */
  riskLevel: string;
  /** 决策：allowed / denied / allowed-confirmed（写确认闸批准后执行；拒绝原因见 reason/code） */
  decision: 'allowed' | 'denied' | 'allowed-confirmed';
  reason?: string;
  code?: string;
  /** 本轮写类爆发条数（仅 move/rename 行，KS-7.18） */
  count?: number;
  /** 目标目录隐私摘要 sha256 前 12 位 hex（仅 move/rename 行，无明文路径） */
  targetDirKey?: string;
}

/** runAgentLoop 输入契约 */
export interface RunAgentLoopInput {
  userPrompt: string;
  memories: LoadedMemories;
  isMock: boolean;
  present?: string;
  history?: ChatMessage[];
  summary?: string;
  recentUserTexts?: string[];
  skills?: unknown[];
  tools?: ToolDef[];
}

/** 本地时区 YYYY-MM-DD */
function localDate(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * 解析 THATPERSON_MOCK_TOOL_CALLS：
 * - 扁平数组 [{name,arguments},...] → 视为单轮（注入一次）；
 * - 嵌套数组 [[...],[...],...] → 视为逐轮队列（供 5 轮上限 / 失败重试 / 认输 等路径测试）。
 */
function parseMockRounds(raw: string | undefined): ToolCall[][] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (parsed.length === 0) return [];
    if (Array.isArray(parsed[0])) return parsed as ToolCall[][];
    return [parsed as ToolCall[]];
  } catch {
    return null;
  }
}

/** mock 单轮：返回注入的 toolCalls（队列耗尽后返回空，触发收尾） */
function mockChatOnce(queue: ToolCall[][] | null, index: number): ChatResult {
  if (!queue || index >= queue.length) {
    return { content: `${MOCK_REPLY_PREFIX}本轮工具调用已完成，以上为执行结果摘要。`, toolCalls: [] };
  }
  const calls = queue[index] ?? [];
  const names = calls.map((c) => c.name).join('、');
  return { content: `${MOCK_REPLY_PREFIX}正在调用工具：${names || '无'}。`, toolCalls: calls };
}

/** 每次工具调用追加一行审计日志（写入失败静默；入参为脱敏后的磁盘条目，不含计划明细路径） */
function appendAuditLog(home: string, entry: ToolLogEntry): void {
  try {
    const dir = path.join(home, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `tool-${localDate()}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // 审计日志写入失败不影响主流程
  }
}

/** 将执行结果映射为审计状态 */
function statusOf(result: ToolResult): ToolLogEntry['status'] {
  if (result.ok) return 'ok';
  if (result.error === 'unknown-tool') return 'unknown';
  if (result.error === 'danger-disabled') return 'danger-blocked';
  return 'error';
}

/** 从工具参数中提取候选路径（KS-41 TTY 确认弹窗展示用） */
function extractPathArg(args: Record<string, unknown>): string | null {
  for (const key of ['path', 'file', 'dir', 'source', 'targetDir']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** vaultId 归属根（T10）：vault 默认根 + config.allowedDirs，命中哪个根填其根名 */
interface VaultIdRoot {
  root: string;
  id: string;
}

/**
 * T10 vaultId 归属判定（纯函数）：操作路径参数 resolve 后匹配 vaultRoot()/config.allowedDirs，
 * 命中哪个根填其根名（vault 默认根 → 'vault'；授权目录 → 目录名），无命中返回 undefined（事件省略字段）。
 */
function vaultIdForPath(p: string | null | undefined, roots: VaultIdRoot[]): string | undefined {
  const raw = (p ?? '').trim();
  if (!raw) return undefined;
  let resolved: string;
  try {
    resolved = path.resolve(raw);
  } catch {
    return undefined;
  }
  for (const { root, id } of roots) {
    try {
      const rel = path.relative(root, resolved);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return id;
    } catch {
      // 单根解析失败跳过，继续匹配其余根
    }
  }
  return undefined;
}

/** 单个调用的执行产物（含 confirm-required 计划全文等闸上下文） */
interface CallOutcome {
  tc: ToolCall;
  parsedArgs: Record<string, unknown> | null;
  result: ToolResult;
  started: number;
  /** confirm-required 拒绝时的计划全文：内存 toolLog.reason 回灌用，磁盘审计行/事件流一律脱敏 */
  planText: string | null;
  planKind: WritePlan['kind'] | null;
  /** 经写确认闸批准后执行（审计 decision='allowed-confirmed'） */
  confirmed: boolean;
}

/** 写确认闸拒绝的统一失败信封（回灌模型：reason 含计划全文，unlockHint 为执行器口径） */
function confirmRequiredFailure(riskLevel: 'L0' | 'L1' | 'L2' | 'L3', planText: string): ToolFailure {
  return {
    ok: false,
    error: 'confirm-required',
    code: 'confirm-required',
    riskLevel,
    reason: planText,
    unlockHint: CONFIRM_REQUIRED_HINT,
  };
}

/** 磁盘审计行 reason 脱敏（W-8 双口径：计划路径 → 泛化文案，明细只以条数呈现） */
function gateAuditReason(kind: WritePlan['kind'], entries: number): string {
  return `需要用户确认的写操作未获确认（${kind === 'batch' ? '批量' : '结构性'}写 ${entries} 项，明细不落盘）`;
}

/** 把计划全文解析回条数（磁盘脱敏文案用；解析失败按 0 处理） */
function planEntryCount(planText: string): number {
  const m = /共 (\d+) 项/.exec(planText);
  return m ? Number(m[1]) : 1;
}

/**
 * ReAct 主循环。
 * 返回：{ reply 最终回复, toolLog 本次全部工具调用审计（顺序）,
 *   readContents 本轮成功读类工具结果内容（≤4000 字符/条；只走沉淀提案通道，绝不直接归档）,
 *   readResults 同源结构化（tool+path+content，供提案 evidence 与工具活动统计）,
 *   writeTargets 本轮成功写类工具目标（工具活动统计用） }。
 */
export async function runAgentLoop(
  input: RunAgentLoopInput,
): Promise<{
  reply: string;
  toolLog: ToolLogEntry[];
  readContents?: string[];
  readResults?: LoopReadResult[];
  writeTargets?: Array<{ tool: string; target: string }>;
}> {
  const cwd = process.cwd();
  const home = memoryRoot(cwd);
  // KS-39：allowedRoots 合并 loadConfig().allowedDirs——授权后同一会话内重试即命中
  const allowedRoots = [...new Set(
    [
      home,
      cwd,
      path.join(cwd, '.thatperson'),
      process.env.THATPERSON_VAULT_ROOT,
      ...(loadConfig().allowedDirs ?? []),
    ].filter(Boolean) as string[],
  )].map((p) => path.resolve(p));
  let ctx: ToolContext = { cwd, home, allowedRoots };
  const toolLog: ToolLogEntry[] = [];
  // T11b 沉淀通道捕获：读类成功结果（内容进提案通道，绝不直接归档）与写类成功目标（活动统计用）
  const readResults: LoopReadResult[] = [];
  const writeTargets: Array<{ tool: string; target: string }> = [];
  // T10 vaultId 归属根：vault 默认根（根名 'vault'）+ config.allowedDirs（根名 = 目录名）
  const vaultIdRoots: VaultIdRoot[] = [
    { root: path.resolve(vaultRoot()), id: 'vault' },
    ...(loadConfig().allowedDirs ?? []).map((dir) => ({
      root: path.resolve(dir),
      id: path.basename(dir) || dir,
    })),
  ];
  // KS-41：TTY 确认状态（本轮最多弹一次；临时授权只入本轮 allowedRoots）
  let ttyPromptedOnce = false;
  const tempAllowedRoots: string[] = [];

  // mock 队列：每次 runAgentLoop 重新解析，保证测试之间隔离
  const mockQueue = input.isMock ? parseMockRounds(process.env.THATPERSON_MOCK_TOOL_CALLS) : null;
  let mockIndex = 0;

  const baseMessages: ChatMessage[] = (input.history ?? []).map((m) => ({
    role: m.role,
    content: m.content,
    tool_call_id: m.tool_call_id,
    toolCalls: m.toolCalls,
  }));
  let messages: ChatMessage[] = [...baseMessages];
  let reply = '';
  let consecutiveFailures = 0;
  /** 实际执行过工具调用的轮数（status end 事件用） */
  let roundsWithTools = 0;

  // 事件发射（会话事件协议 v1.0）：agent_start + status start；无 sink 时为 no-op（输出等价）
  emitEvent({ type: 'agent_start' });
  emitEvent({ type: 'status', phase: 'start' });

  for (let round = 0; round <= MAX_TOOL_ITERATIONS; round += 1) {
    // ===== 解析器：调用 chat() 并提取 toolCalls =====
    let res: ChatResult;
    if (input.isMock) {
      res = mockChatOnce(mockQueue, mockIndex);
      mockIndex += 1;
    } else {
      const chatOptions: ChatOptions = {
        presentText: input.present,
        history: messages,
        summary: input.summary,
        recentUserTexts: input.recentUserTexts,
        skills: (input.skills ?? []) as ChatOptions['skills'],
        isMock: false,
        tools: input.tools,
      };
      const raw = await chat(input.userPrompt, input.memories, chatOptions);
      res = raw;
    }
    reply = res.content ?? '';
    const toolCalls = res.toolCalls ?? [];

    if (toolCalls.length === 0) {
      // 模型不再请求工具 → 单轮收尾
      emitEvent({ type: 'status', phase: 'end', rounds: roundsWithTools });
      // 统一出口：携带 T11b 沉淀通道捕获（readContents/readResults）与 T10 写类目标
      return { reply, toolLog, readContents: readResults.map((r) => r.content), readResults, writeTargets };
    }
    if (round >= MAX_TOOL_ITERATIONS) {
      // 已达上限：不再执行本轮工具，附加说明后终止
      emitEvent({ type: 'status', phase: 'end', rounds: roundsWithTools });
      return { reply: reply + MAX_ITERATION_NOTE, toolLog, readContents: readResults.map((r) => r.content), readResults, writeTargets };
    }

    // 先把本轮助手回复追加进消息流（必须携带 tool_calls，否则下一轮 role='tool' 消息无对应 assistant tool_calls，
    // DeepSeek 会以 HTTP 400「Messages with role 'tool' must be a response to a preceding message with 'tool_calls'」拒绝）
    messages.push({ role: 'assistant', content: reply, toolCalls });
    roundsWithTools += 1;

    // 预解析参数（闸与执行共用；解析失败保持既有 invalid-json-args 语义）
    const parsedArgsList: Array<Record<string, unknown> | null> = toolCalls.map((tc) => {
      try {
        const parsed: unknown = JSON.parse(tc.arguments);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    });

    // ===== 写确认闸（KS-7.15）：单轮写类 ≥3 → 整批计划确认（闸在执行器段，DD-7.3）=====
    const writeIndexes = toolCalls
      .map((_, i) => i)
      .filter((i) => isWriteClass(toolCalls[i].name));
    let batchApproved = false;
    let batchPlan: WritePlan | null = null;
    if (writeIndexes.length >= WRITE_GATE_THRESHOLD) {
      batchPlan = buildWritePlan(toolCalls, 'batch');
      batchApproved = await resolveWriteConfirm(batchPlan, {
        isMock: input.isMock,
        isTTY: Boolean(process.stdin.isTTY),
      });
    }

    // ===== 执行器：逐调用产出 CallOutcome（含闸拒绝的结构化结果）=====
    const outcomes: CallOutcome[] = [];
    const batchPlanText = batchPlan && !batchApproved ? renderWritePlan(batchPlan) : null;
    for (const [i, tc] of toolCalls.entries()) {
      const started = Date.now();
      // 批量闸拒绝（KS-7.15）：整批不执行，每个 tool_call 回灌 confirm-required（reason 含计划全文回灌模型改为提案）；
      // vault 零变化、审计只记 denied（磁盘行脱敏，见下方出口）
      if (batchPlanText) {
        outcomes.push({
          tc,
          parsedArgs: parsedArgsList[i],
          result: confirmRequiredFailure(getTool(tc.name)?.riskLevel ?? 'L2', batchPlanText),
          started,
          planText: batchPlanText,
          planKind: 'batch',
          confirmed: false,
        });
        continue;
      }
      const parsedArgs = parsedArgsList[i];
      if (!parsedArgs) {
        outcomes.push({
          tc,
          parsedArgs: null,
          result: {
            ok: false,
            error: 'invalid-json-args',
            code: 'param-invalid',
            riskLevel: getTool(tc.name)?.riskLevel ?? 'L0',
            reason: '工具参数 JSON 解析失败',
            unlockHint: '',
          },
          started,
          planText: null,
          planKind: null,
          confirmed: false,
        });
        continue;
      }
      // 结构性写单次确认（KS-7.16）：move/rename 目标目录在 home 外 → 执行前确认；
      // 本轮已整批批准则不再重复确认；home 内不确认
      let structuralConfirmed = false;
      let gatePlan: WritePlan | null = null;
      if (!batchApproved && (tc.name === 'move_file' || tc.name === 'rename_file')) {
        const targetDir = structuralTargetDirOf(tc.name, parsedArgs);
        if (targetDir && isOutsideHome(targetDir, home)) {
          const plan: WritePlan = { kind: 'structural', entries: [planEntryOf(tc.name, parsedArgs)] };
          const approved = await resolveWriteConfirm(plan, {
            isMock: input.isMock,
            isTTY: Boolean(process.stdin.isTTY),
          });
          if (!approved) {
            gatePlan = plan;
          } else {
            structuralConfirmed = true;
          }
        }
      }
      if (gatePlan) {
        const planText = renderWritePlan(gatePlan);
        outcomes.push({
          tc,
          parsedArgs,
          result: confirmRequiredFailure(getTool(tc.name)?.riskLevel ?? 'L2', planText),
          started,
          planText,
          planKind: 'structural',
          confirmed: false,
        });
        continue;
      }
      let result: ToolResult;
      try {
        result = await executeTool(tc.name, parsedArgs, ctx, { dangerAllowed: false });
        // KS-41：TTY 确认——首次 path-denied 弹一次「是否允许访问 <路径>？(y/N)」；
        // 批准 → 临时入本轮 allowedRoots 并提示持久化；拒绝/非交互（管道/--input-file/--mock）不弹不自动授权。
        if (
          !result.ok &&
          result.code === 'path-denied' &&
          !input.isMock &&
          process.stdin.isTTY &&
          !ttyPromptedOnce
        ) {
          const candidate = extractPathArg(parsedArgs);
          if (candidate) {
            ttyPromptedOnce = true;
            const { ask } = await import('../utils/ui');
            const approved = await ask(`是否允许访问 ${candidate}？(y/N)`, 'confirm');
            if (approved) {
              tempAllowedRoots.push(path.resolve(candidate));
              ctx = { ...ctx, allowedRoots: [...new Set([...ctx.allowedRoots, ...tempAllowedRoots])] };
              console.log('[ThatPerson] 已临时允许本轮访问该路径；如需持久化请运行 thatperson allow-dir <绝对路径>');
              result = await executeTool(tc.name, parsedArgs, ctx, { dangerAllowed: false });
            }
          }
        }
      } catch {
        result = {
          ok: false,
          error: 'invalid-json-args',
          code: 'param-invalid',
          riskLevel: getTool(tc.name)?.riskLevel ?? 'L0',
          reason: '工具参数 JSON 解析失败',
          unlockHint: '',
        };
      }
      outcomes.push({
        tc,
        parsedArgs,
        result,
        started,
        planText: null,
        planKind: null,
        confirmed: structuralConfirmed || (batchApproved && isWriteClass(tc.name)),
      });
    }

    // ===== 审计 + 回灌 + 事件发射（批量拒绝与逐条执行共用同一出口）=====
    const toolMessages: ChatMessage[] = [];
    let anyOk = false;
    let lastTool = '';
    let lastFailure: ToolFailure | null = null;
    for (const out of outcomes) {
      const ms = Date.now() - out.started;
      const status = statusOf(out.result);
      if (!out.result.ok) {
        lastTool = out.tc.name;
        lastFailure = out.result;
      }
      const argsKeys = out.parsedArgs ? Object.keys(out.parsedArgs).sort() : [];
      // KS-7.18：move/rename 审计行补 count（本轮写类条数）与 targetDirKey（sha256 前 12 位 hex）
      const isMoveRename = out.tc.name === 'move_file' || out.tc.name === 'rename_file';
      const count = isMoveRename ? writeIndexes.length : undefined;
      const targetDir = out.parsedArgs ? structuralTargetDirOf(out.tc.name, out.parsedArgs) : null;
      const targetDirKey = isMoveRename && targetDir ? targetDirKeyOf(targetDir) : undefined;
      const decision: ToolLogEntry['decision'] = out.result.ok
        ? out.confirmed
          ? 'allowed-confirmed'
          : 'allowed'
        : 'denied';
      const entry: ToolLogEntry = {
        ts: new Date().toISOString(),
        tool: out.tc.name,
        argsKeys,
        status,
        ms,
        riskLevel: out.result.ok ? (getTool(out.tc.name)?.riskLevel ?? 'L0') : out.result.riskLevel,
        decision,
        reason: out.result.ok ? undefined : out.result.reason,
        code: out.result.ok ? undefined : out.result.code,
        ...(count !== undefined ? { count } : {}),
        ...(targetDirKey !== undefined ? { targetDirKey } : {}),
      };
      toolLog.push(entry);
      // W-8 双口径：磁盘审计行 reason 脱敏（计划全文只留在内存 toolLog 供回灌，不落盘不进事件）
      const auditReason = out.planText && out.planKind
        ? gateAuditReason(out.planKind, planEntryCount(out.planText))
        : out.result.ok
          ? undefined
          : out.result.reason;
      appendAuditLog(home, auditReason === undefined ? entry : { ...entry, reason: auditReason });

      // 事件发射：tool_call（已在执行前发射）/ tool_result / memory_write / error
      // T10：tool_call/tool_result/memory_write 按操作路径归属挂载根（vaultId 命中才带，无命中省略字段）
      const def = getTool(out.tc.name);
      const opVaultId = vaultIdForPath(out.parsedArgs ? extractPathArg(out.parsedArgs) : null, vaultIdRoots);
      emitEvent({
        type: 'tool_call',
        name: out.tc.name,
        argsKeys,
        policy: def?.policy ?? 'unknown',
        riskLevel: (out.result.ok ? def?.riskLevel ?? 'L0' : out.result.riskLevel) as 'L0' | 'L1' | 'L2' | 'L3',
        ...(opVaultId ? { vaultId: opVaultId } : {}),
      });
      emitEvent({
        type: 'tool_result',
        name: out.tc.name,
        ok: out.result.ok,
        ...(out.result.ok ? {} : { code: out.result.code }),
        ms,
        riskLevel: entry.riskLevel as 'L0' | 'L1' | 'L2' | 'L3',
        ...(opVaultId ? { vaultId: opVaultId } : {}),
      });
      // T11b 沉淀通道捕获：成功读类结果（内容 ≤4000 字符/条）与成功写类目标
      if (out.result.ok && READ_CLASS_TOOLS.has(out.tc.name)) {
        readResults.push({
          tool: out.tc.name,
          path: (out.parsedArgs ? extractPathArg(out.parsedArgs) : '') ?? '',
          content: out.result.content.slice(0, READ_CONTENT_LIMIT),
        });
      }
      if (out.result.ok && isWriteClass(out.tc.name) && out.parsedArgs) {
        // memory_write（写类工具成功；只记位置元数据，不含明文全路径）
        const target = planEntryOf(out.tc.name, out.parsedArgs).target.replace(/\\/g, '/');
        const section = /history\/([^/]+)\//.exec(target)?.[1];
        const file = path.posix.basename(target);
        const memVaultId = vaultIdForPath(target, vaultIdRoots);
        emitEvent({
          type: 'memory_write',
          tool: out.tc.name,
          ...(section ? { section } : {}),
          ...(file ? { file } : {}),
          ...(memVaultId ? { vaultId: memVaultId } : {}),
        });
        writeTargets.push({ tool: out.tc.name, target });
      }
      if (!out.result.ok) {
        emitEvent({ type: 'error', tool: out.tc.name, code: out.result.code, message: auditReason ?? out.result.reason });
      }
      if (out.result.ok) anyOk = true;
      toolMessages.push({ role: 'tool', tool_call_id: out.tc.id, content: JSON.stringify(out.result) });
    }

    consecutiveFailures = anyOk ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // 连续失败 3 次 → 卡点诊断模板（KS-36：等级/守卫/解锁，不再「我做不到」）
      const giveUp = lastFailure ? formatGiveUp(round + 1, lastTool, lastFailure) : reply;
      emitEvent({ type: 'status', phase: 'end', rounds: roundsWithTools });
      return { reply: giveUp, toolLog, readContents: readResults.map((r) => r.content), readResults, writeTargets };
    }
    messages.push(...toolMessages);
  }

  emitEvent({ type: 'status', phase: 'end', rounds: roundsWithTools });
  return { reply: reply + MAX_ITERATION_NOTE, toolLog, readContents: readResults.map((r) => r.content), readResults, writeTargets };
}
