/**
 * 会话事件总线（第 7 期批次一 · KS-7.1~7.6；会话事件协议 v1.0）
 *
 * 职责：进程内事件类型定义 + 最小总线。核心引擎只 emit 不感知 UI（渲染层 / web 层同为 sink 消费者）。
 * - NDJSON 载体：BaseEvent { seq, ts, type, vaultId?, ...payload }，一行一事件，UTF-8；
 * - seq 进程内单调递增（从 1 起）；ts 为 ISO 8601 UTC；
 * - 零依赖（node 原生全局，不 import 任何模块）；
 * - 默认零 sink：CLI 输出与现状逐字节等价（KS-7.6 向后兼容铁律）；
 * - sink 抛错静默：不影响主流程。
 *
 * 发射点接线（loop / chat / cli）由批次一 task 2 实现方接线；本文件只承载类型与总线。
 */

/** 事件类型集（批次一 11 类；批次三新增均为可选字段/新类型，消费者必须忽略未知 type） */
export type EventType =
  | 'agent_start'
  | 'agent_message'
  | 'tool_call'
  | 'tool_result'
  | 'memory_read'
  | 'memory_write'
  | 'status'
  | 'error'
  | 'session_meta'
  | 'skill_start'
  | 'skill_step';

/** 全部事件类型（供消费者/测试枚举校验） */
export const EVENT_TYPES: readonly EventType[] = [
  'agent_start',
  'agent_message',
  'tool_call',
  'tool_result',
  'memory_read',
  'memory_write',
  'status',
  'error',
  'session_meta',
  'skill_start',
  'skill_step',
];

/** 事件风险等级（与工具层 L0~L3 对齐；此处内联定义保持零依赖） */
export type EventRiskLevel = 'L0' | 'L1' | 'L2' | 'L3';

/** 事件基座：seq 进程内单调递增（从 1 起），ts ISO 8601 UTC，vaultId 缺省省略（语义 = 'default'，批次三用） */
export interface BaseEvent {
  seq: number;
  ts: string;
  type: EventType;
  vaultId?: string;
}

/** loop.ts 循环启动 */
export interface AgentStartEvent extends BaseEvent {
  type: 'agent_start';
  rounds?: number;
}

/** runLlmTurn 最终回复（本地产品输出，可含正文） */
export interface AgentMessageEvent extends BaseEvent {
  type: 'agent_message';
  role: 'assistant';
  content: string;
  streaming: false;
}

/** loop.ts 执行器段每调用前（只记参数键名，隐私口径） */
export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  name: string;
  argsKeys: string[];
  policy: string;
  riskLevel: EventRiskLevel;
}

/** loop.ts 每调用后（不含结果全文） */
export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  name: string;
  ok: boolean;
  code?: string;
  ms: number;
  riskLevel: EventRiskLevel;
}

/** runLlmTurn 装载 / retrieveRelevant 命中（只记计数与节名） */
export interface MemoryReadEvent extends BaseEvent {
  type: 'memory_read';
  phase: 'load' | 'retrieve';
  sections?: string[];
  hits?: number;
  keywords?: number;
}

/** loop.ts 写类工具成功（只记位置）；sediment 沉淀动作经 action 增量可选字段（T11b，协议向前兼容） */
export interface MemoryWriteEvent extends BaseEvent {
  type: 'memory_write';
  tool: string;
  section?: string;
  file?: string;
  action?: 'propose' | 'accept' | 'reject';
}

/** loop 首尾 + chat() 记账后 */
export interface StatusEvent extends BaseEvent {
  type: 'status';
  phase: 'start' | 'end' | 'llm';
  rounds?: number;
  tokenUsage?: { prompt: number; completion: number; total: number };
}

/** loop.ts 结构化失败（message 不含 Key/明文路径） */
export interface ErrorEvent extends BaseEvent {
  type: 'error';
  tool?: string;
  code: string;
  message: string;
}

/** /save /load /title 处理器 */
export interface SessionMetaEvent extends BaseEvent {
  type: 'session_meta';
  action: 'save' | 'load' | 'title';
  id?: string;
  title?: string;
}

/** processInput 命中技能 */
export interface SkillStartEvent extends BaseEvent {
  type: 'skill_start';
  name: string;
}

/** 技能上下文注入 */
export interface SkillStepEvent extends BaseEvent {
  type: 'skill_step';
  name: string;
  step: string;
}

/** 全部事件联合（11 类） */
export type AgentEvent =
  | AgentStartEvent
  | AgentMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | MemoryReadEvent
  | MemoryWriteEvent
  | StatusEvent
  | ErrorEvent
  | SessionMetaEvent
  | SkillStartEvent
  | SkillStepEvent;

/** 分发式 Omit：对联合逐成员剔除 seq/ts，得到 emitEvent 的入参类型（seq/ts 由总线装配） */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** emitEvent 入参：完整 payload，但 seq/ts 由总线装配 */
export type EventInput = DistributiveOmit<AgentEvent, 'seq' | 'ts'>;

/** 事件订阅者：收到装配完成的完整事件；抛错由总线静默吞掉 */
export type EventSink = (event: AgentEvent) => void;

/** 全部 sink（Set 保持去重；通知时快照遍历，允许 sink 内安全增删） */
const sinks = new Set<EventSink>();
/** 进程内 seq 计数器（从 1 起，单调递增） */
let seqCounter = 0;

/** 订阅事件流（CLI --events 文件 sink / 渲染层 / 批次二 web 层） */
export function subscribeEventSink(sink: EventSink): void {
  sinks.add(sink);
}

/** 清空全部 sink（测试隔离 / 退出前清理） */
export function clearEventSinks(): void {
  sinks.clear();
}

/**
 * 发射事件：装配 seq/ts 后通知全部 sink。
 * - 无 sink 时为 no-op（CLI 输出零变化，KS-7.6）；
 * - sink 抛错静默，不影响主流程；
 * - 未知字段由消费者忽略（向前兼容）。
 */
export function emitEvent(input: EventInput): void {
  seqCounter += 1;
  const event = { ...input, seq: seqCounter, ts: new Date().toISOString() } as AgentEvent;
  for (const sink of [...sinks]) {
    try {
      sink(event);
    } catch {
      // sink 失败静默（KS-7.3）
    }
  }
}
