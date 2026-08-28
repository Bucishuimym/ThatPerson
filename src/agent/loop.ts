/**
 * ReAct 循环（第 5 期批次二 · KS-20；第 6 期批次二 · KS-36 卡点诊断 / KS-38 审计 / KS-39 allow-dir / KS-41 TTY 确认）
 *
 * 三段结构：解析（chat() 返回 toolCalls）→ 执行（executeTool，danger 默认禁用）
 * → 回灌（tool 结果拼进 messages 再调 chat()），循环直到无 toolCalls 或达 MAX_TOOL_ITERATIONS。
 *
 * 安全约束：
 * - 审计日志只记参数键名（argsKeys），绝不记录参数值 / API Key；写入失败静默；
 * - 路径白名单 ctx.allowedRoots = [home, cwd, cwd/.thatperson, THATPERSON_VAULT_ROOT]；
 * - 连续失败 3 次 → 卡点诊断模板（含等级/守卫/解锁，消灭「我做不到」）并终止；
 * - 结构化失败信封（code/riskLevel/reason/unlockHint）回灌给模型；
 * - 审计日志补记 riskLevel 与 decision（allowed/denied）；
 * - TTY 确认：非 --mock 且 stdin 为 TTY 时，首次 path-denied 弹一次确认；非交互/管道/--mock 一律不弹不自动授权；
 * - --mock 路径完全不调用 chat()/API：首轮返回（离线演示）回复，支持通过
 *   THATPERSON_MOCK_TOOL_CALLS（JSON）注入工具调用以便测试三段可测。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chat, type ChatMessage, type ChatOptions, type ChatResult, type ToolCall } from '../chat';
import { loadConfig, memoryRoot } from '../config';
import { executeTool } from '../tools/executor';
import { envInt } from '../tools/guards';
import { getTool } from '../tools/registry';
import type { ToolContext, ToolDef, ToolFailure, ToolResult } from '../tools/types';
import type { LoadedMemories } from '../memory/types';

/** 单轮最多执行的工具调用轮次（THATPERSON_MAX_TOOL_ITERATIONS 可调，默认 12） */
export const MAX_TOOL_ITERATIONS = envInt('THATPERSON_MAX_TOOL_ITERATIONS', 12);
/** 连续失败阈值：达到即认输 */
const MAX_CONSECUTIVE_FAILURES = 3;
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

/** 工具调用审计日志条目（只含参数键名，绝不含参数值 / Key；KS-38 补记 riskLevel 与 decision） */
export interface ToolLogEntry {
  ts: string;
  tool: string;
  argsKeys: string[];
  status: 'ok' | 'error' | 'danger-blocked' | 'unknown';
  ms: number;
  /** 风险等级（L0~L3） */
  riskLevel: string;
  /** 决策：allowed / denied（拒绝原因见 reason/code） */
  decision: 'allowed' | 'denied';
  reason?: string;
  code?: string;
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

/** 每次工具调用追加一行审计日志（字段仅 ts/tool/argsKeys/status/ms；写入失败静默） */
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

/**
 * ReAct 主循环。
 * 返回：{ reply 最终回复, toolLog 本次全部工具调用审计（顺序） }。
 */
export async function runAgentLoop(
  input: RunAgentLoopInput,
): Promise<{ reply: string; toolLog: ToolLogEntry[] }> {
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
      return { reply, toolLog };
    }
    if (round >= MAX_TOOL_ITERATIONS) {
      // 已达上限：不再执行本轮工具，附加说明后终止
      return { reply: reply + MAX_ITERATION_NOTE, toolLog };
    }

    // 先把本轮助手回复追加进消息流（必须携带 tool_calls，否则下一轮 role='tool' 消息无对应 assistant tool_calls，
    // DeepSeek 会以 HTTP 400「Messages with role 'tool' must be a response to a preceding message with 'tool_calls'」拒绝）
    messages.push({ role: 'assistant', content: reply, toolCalls });

    // ===== 执行器 + 回灌器：逐个执行并把结果拼进 messages =====
    const toolMessages: ChatMessage[] = [];
    let anyOk = false;
    let lastTool = '';
    let lastFailure: ToolFailure | null = null;
    for (const tc of toolCalls) {
      const started = Date.now();
      let parsedArgs: Record<string, unknown> = {};
      let result: ToolResult;
      try {
        parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
        if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
          throw new Error('arguments 必须是 JSON 对象');
        }
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
      const status = statusOf(result);
      if (!result.ok) {
        lastTool = tc.name;
        lastFailure = result;
      }
      const entry: ToolLogEntry = {
        ts: new Date().toISOString(),
        tool: tc.name,
        argsKeys: Object.keys(parsedArgs).sort(),
        status,
        ms: Date.now() - started,
        riskLevel: result.ok ? (getTool(tc.name)?.riskLevel ?? 'L0') : result.riskLevel,
        decision: result.ok ? 'allowed' : 'denied',
        reason: result.ok ? undefined : result.reason,
        code: result.ok ? undefined : result.code,
      };
      toolLog.push(entry);
      appendAuditLog(home, entry);
      if (result.ok) anyOk = true;
      toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }

    consecutiveFailures = anyOk ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // 连续失败 3 次 → 卡点诊断模板（KS-36：等级/守卫/解锁，不再「我做不到」）
      const giveUp = lastFailure ? formatGiveUp(round + 1, lastTool, lastFailure) : reply;
      return { reply: giveUp, toolLog };
    }
    messages.push(...toolMessages);
  }

  return { reply: reply + MAX_ITERATION_NOTE, toolLog };
}
