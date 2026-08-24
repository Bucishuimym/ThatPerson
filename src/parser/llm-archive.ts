/**
 * LLM 语义归档模块（第 4 期 · D-1 · 增强层）
 *
 * 与规则版关系（KeySpecs S-13/S-14）：extractArchives 永为兜底，本模块为增强。
 * - 默认关闭：仅当环境变量 THATPERSON_LLM_ARCHIVE === 'true' 且非 mock 时才真正调用 LLM；
 *   否则一律返回 []（离线安全，不发起网络请求、不读 Key）。
 * - 端点复用 src/chat.ts 的 BASE_URL / MODEL（白名单端点）；Key 读独立
 *   AAGENTDS_ARCHIVE_API_KEY（第 5 期 KS-22：禁止复用主 Key AAGENTDS_API_KEY），
 *   不硬编码、不落日志、不进 System。
 * - LLM 输出必须为可解析 JSON 数组，解析/校验失败一律降级返回 []（规则版兜底），
 *   绝不抛错阻塞主流程。不新增运行时依赖。
 *
 * 注意：本模块接口签名由 D-1 任务锁定，cli.ts 接线方不得修改。
 */
import { BASE_URL, MODEL, loadEnv } from '../chat';
import type { ArchiveEntry, ArchiveType, Confidence } from '../memory/types';

export interface LlmArchiveOptions {
  /** 离线演示模式：true 时不发起网络请求、不读 Key */
  isMock?: boolean;
  /** 显式传入 Key（优先级最高；默认按 AAGENTDS_ARCHIVE_API_KEY 从 .env 读取，不复用主 Key） */
  apiKey?: string;
  /** 模型覆盖（默认复用 chat.ts 的 MODEL） */
  model?: string;
  /** 请求超时毫秒数（默认 30_000） */
  timeoutMs?: number;
}

/** 合法归档类型（对齐 memory/types ArchiveType） */
const ARCHIVE_TYPES: readonly ArchiveType[] = ['偏好', '经历', '日期', '身份', '模式'];

/** 合法置信度（对齐 memory/types Confidence） */
const CONFIDENCES: readonly Confidence[] = ['高', '中', '低'];

/** 从 LLM 输出文本中解析 JSON 数组（容忍 ```json 代码块包裹与前后杂讯） */
function parseJsonArray(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 校验单个归档条目（S-13：防伪造 / 防编造记忆；任一字段非法即整批无效） */
function isValidArchiveEntry(value: unknown): value is ArchiveEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.type !== 'string' || !ARCHIVE_TYPES.includes(entry.type as ArchiveType)) return false;
  if (typeof entry.confidence !== 'string' || !CONFIDENCES.includes(entry.confidence as Confidence)) return false;
  if (typeof entry.dialog !== 'string' || entry.dialog.trim().length === 0) return false;
  if (typeof entry.insight !== 'string' || entry.insight.trim().length === 0) return false;
  if (!Array.isArray(entry.tags) || !entry.tags.every((t) => typeof t === 'string')) return false;
  if (entry.conflict !== undefined && typeof entry.conflict !== 'string') return false;
  return true;
}

/** 构造归档专用 system prompt（字段对齐 ArchiveEntry） */
function buildArchivePrompt(userText: string, assistantText: string): Array<{ role: string; content: string }> {
  const schema = [
    'type: 只能是 偏好 / 经历 / 日期 / 身份 / 模式 之一',
    'dialog: 用户原话片段（非空字符串）',
    'insight: 1-2 句中文概括（非空字符串）',
    'confidence: 只能是 高 / 中 / 低 之一',
    'tags: 字符串数组，例如 ["#咖啡", "#饮食偏好"]',
  ].join('\n');
  return [
    {
      role: 'system',
      content:
        '你是 ThatPerson 的记忆归档提取器。请根据用户本轮对话提取值得长期记忆的条目，只输出一个 JSON 数组（不要 Markdown，不要多余解释）。\n' +
        '字段要求：\n' +
        schema +
        '\n硬性规则：\n' +
        '1. insight 必须是对 dialog 的语义概括（用自己的话总结），禁止原样截取用户原话片段；\n' +
        '2. 同一条 dialog 不得产出多条同类型条目（同类型只保留一条）；\n' +
        '3. 用户表达不确定（不确定/也许/可能/说不定/大概/或许 等）时 confidence 一律用「中」，且不得同时产出「偏好」与「经历」两条；\n' +
        '4. 只提取用户明确说出或可合理推断的内容，不得编造记忆；无法提取时输出 []。',
    },
    {
      role: 'user',
      content: '用户说：' + (userText || '') + '\n助手说：' + (assistantText || ''),
    },
  ];
}

/**
 * LLM 语义归档（增强层）。
 * 默认关闭：仅当 THATPERSON_LLM_ARCHIVE === 'true' 且非 mock 时调用 LLM；
 * 其余情况（含无 Key / 网络异常 / 输出非法）一律返回 []，由规则版兜底。
 */
export async function llmExtractArchives(
  userText: string,
  assistantText: string,
  opts?: LlmArchiveOptions,
): Promise<ArchiveEntry[]> {
  if (opts?.isMock) return [];
  if (process.env.THATPERSON_LLM_ARCHIVE !== 'true') return [];
  // 沿用 chat.ts 的 loadEnv 语义：加载项目根 .env，不覆盖系统环境变量（幂等，安全）
  loadEnv();
  const apiKey = opts?.apiKey || process.env.AAGENTDS_ARCHIVE_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: opts?.model || MODEL,
        messages: buildArchivePrompt(userText, assistantText),
        stream: false,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) return [];
    const parsed = parseJsonArray(content);
    if (!Array.isArray(parsed)) return [];
    const entries: ArchiveEntry[] = [];
    for (const item of parsed) {
      // 任一条目非法视为整批无效（S-13 防伪造口径），降级返回 []
      if (!isValidArchiveEntry(item)) return [];
      entries.push(item);
    }
    return entries;
  } catch {
    // 网络 / 解析 / 超时异常一律降级，绝不抛错阻塞主流程
    return [];
  }
}

/**
 * 合并归档：LLM 结果为主，规则版补充 LLM 未覆盖的 type；
 * 按 dialog 去重（相同保留 LLM 版）。返回顺序：LLM 条目在前，补充的规则条目在后。
 */
export function mergeArchives(ruleArchives: ArchiveEntry[], llmArchives: ArchiveEntry[]): ArchiveEntry[] {
  const merged: ArchiveEntry[] = [...llmArchives];
  const seenDialogs = new Set(merged.map((entry) => entry.dialog));
  const coveredTypes = new Set(merged.map((entry) => entry.type));
  for (const rule of ruleArchives) {
    if (coveredTypes.has(rule.type)) continue; // LLM 已覆盖该 type，规则版仅补缺
    if (seenDialogs.has(rule.dialog)) continue;
    seenDialogs.add(rule.dialog);
    merged.push(rule);
  }
  return merged;
}