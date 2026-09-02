/**
 * 记忆沉淀模块（第 7 期批次三 T11b · D-3b 实现）
 *
 * 职责（KS-7.27 裁剪版）：提议式沉淀——读类工具结果（read_file/read_vault_note/search 命中）
 * + 回复 → 画像提案卡；确认四级解析同写闸（桩 → mock 未确认 → TTY → 非交互未确认）；
 * 确认后 appendArchive，拒绝不落盘。
 *
 * 铁律（一票否决级，编码进 entryOfProposal/applyProposals）：
 * - source:file 只进 insights/（patterns.md，归档类型固定「模式」），**永不进 profile**
 *   （对抗性提案 source:file + drawer:profile 一律改写为 insights，防虚拟幻象零污染）；
 * - profile 只收 source:dialog；
 * - 工具结果不直接归档（提案卡必须经确认闸）。
 *
 * 事件（会话事件协议 v1.0）：提案产出/确认/拒绝各 emit memory_write
 * （action:'propose'|'accept'|'reject'）。events.ts 为禁触文件（只消费），action 为 T11b
 * 增量字段——协议约定「消费者必须忽略未知字段」，此处结构化透传挂载。
 *
 * 写盘口径：cli 接线走 confirmAndApply(→ applyProposals(store))，与既有归档同一 store
 * （软上限/压缩/格式一致）；commitSediment（测试/独立入口）经 directStoreFor 直写指定
 * historyDir，块格式与 src/memory/store.ts formatArchiveEntry 对齐（勿漂移）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  ArchiveEntry,
  ArchiveType,
  Confidence,
  MemorySection,
  MemoryStore,
} from './memory/types';
import { extractArchives } from './parser/archive';
import { emitEvent, type EventInput } from './events';

/** 证据定位：source:file 提案必带（文件路径 + 行区间，1 起） */
export interface SedimentEvidence {
  path: string;
  lineStart: number;
  lineEnd: number;
}

/** 抽屉：提案卡落点（source:file 只允许 'insights'；'profile' 只收 source:dialog） */
export type SedimentDrawer = 'insights' | 'profile';

/** 沉淀来源：file=读类工具结果（只进 insights/）；dialog=对话陈述（userText/assistantText） */
export type SedimentSource = 'file' | 'dialog';

/** 画像提案卡 */
export interface SedimentProposal {
  /** 抽屉：insights（模式/习惯，source:file 唯一合法落点）或 profile（source:dialog 专属） */
  drawer: SedimentDrawer;
  /** 提炼信息（1-2 句概括） */
  insight: string;
  /** 来源类型：file（必带 evidence）/ dialog */
  source: SedimentSource;
  /** 证据（source:file 必带；source:dialog 可省） */
  evidence?: SedimentEvidence;
  /** 置信度：高=文件/明确陈述，中=推断，低=单次暗示 */
  confidence: Confidence;
  /** 归档类型（落盘映射用）：dialog 条目保留 extractArchives 类型；file 条目固定「模式」。缺省按 drawer 推断 */
  type?: ArchiveType;
  /** 原句（dialog=用户原话；file=源文件原句） */
  dialog?: string;
  /** 关联标签（落盘用；缺省给兜底标签） */
  tags?: string[];
}

/** proposeFromTurn 入参：读类工具结果 + 本轮回复（+ 用户输入） */
export interface SedimentInput {
  /** 本轮读类工具结果（read_file/read_vault_note/search 命中；含 path 与截断前 content） */
  toolResults: Array<{ tool: string; path?: string; content: string }>;
  /** 本轮 assistant 回复文本 */
  assistantText: string;
  /** 本轮用户输入（可选，dialog 通道补充） */
  userText?: string;
}

/** 确认处理器：收到提案卡列表，返回是否确认落盘（对应写闸 setWriteConfirmHandler 的确认四级解析） */
export type SedimentConfirmHandler = (proposals: SedimentProposal[]) => boolean | Promise<boolean>;

/** commitSediment 选项 */
export interface CommitSedimentOptions {
  /** 记忆 history 目录（insights/patterns.md 等相对落点的根；S-2 口径 = <home>/history） */
  historyDir: string;
  /** mock 语义：未确认一律拒绝（确认四级：桩 → mock 未确认 → TTY → 非交互未确认） */
  isMock?: boolean;
}

/** commitSediment 返回：确认后实际落盘的文件（相对 history/ 的路径）；拒绝时为空 */
export interface CommitSedimentResult {
  written: string[];
  confirmed: boolean;
}

/** applyProposals 返回：逐条落盘结果（accepted=已写入；rejected=按铁律/未知来源拒绝，零写入） */
export interface ApplyProposalsResult {
  accepted: SedimentProposal[];
  rejected: SedimentProposal[];
  /** 实际写入的 history/ 相对文件（去重） */
  files: string[];
}

/** confirmAndApply 返回：确认闸结果 + applyProposals 结果 */
export interface ConfirmApplyResult extends ApplyProposalsResult {
  confirmed: boolean;
}

// ===== 常量 =====

/** 读类工具集合（沉淀候选来源；与 loop.ts 捕获集合一致） */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'read_vault_note',
  'search_vault',
  'search_memory',
  'vault_search',
]);

/** 单个工具结果最多提案数（防刷屏） */
const PROPOSALS_PER_RESULT = 5;
/** 参与提案解析的最大内容长度（超长截断，证据行区间按截断前文本定位） */
const PROPOSAL_CONTENT_LIMIT = 20_000;

/** 归档类型 → history/ 相对落点（与 src/memory/store.ts ARCHIVE_TARGETS 语义对齐，勿漂移） */
const ARCHIVE_REL_TARGETS: Record<ArchiveType, string> = {
  偏好: 'profile/preferences.md',
  身份: 'profile/identity.md',
  经历: 'experiences/journal.md',
  日期: 'timeline/important_dates.md',
  模式: 'insights/patterns.md',
};

/** 归档类型 → 记忆分区（与 chat.ts sectionOf 同映射；本地持有避免对 chat 的无谓依赖） */
function sectionOfType(type: ArchiveType): MemorySection {
  if (type === '偏好' || type === '身份') return 'profile';
  if (type === '经历') return 'experiences';
  if (type === '日期') return 'timeline';
  return 'insights';
}

// ===== 事件 =====

type MemoryWriteEventInput = Extract<EventInput, { type: 'memory_write' }>;

/** 沉淀事件（memory_write + action）。action 已由 events.ts 显式声明为可选字段（Q-1 备忘③收口） */
function emitSedimentEvent(
  action: 'propose' | 'accept' | 'reject',
  section?: string,
  file?: string,
): void {
  const payload = {
    type: 'memory_write',
    tool: 'sediment',
    ...(section ? { section } : {}),
    ...(file ? { file } : {}),
    action,
  } as MemoryWriteEventInput;
  emitEvent(payload);
}

// ===== 提案卡生成 =====

/** 归档条目 → file 通道提案卡（铁律：drawer 强制 insights，type 固定「模式」） */
function fileProposalOf(entry: ArchiveEntry, srcPath: string, range: SedimentEvidence): SedimentProposal {
  return {
    drawer: 'insights',
    insight: entry.insight,
    source: 'file',
    evidence: range,
    confidence: entry.confidence,
    type: '模式',
    dialog: entry.dialog,
  };
}

/** 提案卡 → 归档类型（外部构造的提案缺省 type 时按 drawer 推断） */
function proposalType(p: SedimentProposal): ArchiveType {
  return p.type ?? (p.drawer === 'profile' ? '偏好' : '模式');
}

/** 提案卡判重（type+提炼信息相似：相同或互为包含视为同一条，先到先留） */
function similarProposal(a: SedimentProposal, b: SedimentProposal): boolean {
  if (proposalType(a) !== proposalType(b)) return false;
  const x = a.insight.trim();
  const y = b.insight.trim();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** 在多行文本中定位原句的行区间（1 起；命中行含归一化原句 → 单行区间；否则按首尾片段跨行定位；兜底 1-1） */
function locateLineRange(content: string, snippet: string): { lineStart: number; lineEnd: number } {
  const norm = (s: string): string => s.replace(/\s+/g, '');
  const target = norm(snippet);
  if (!target) return { lineStart: 1, lineEnd: 1 };
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (norm(lines[i]).includes(target)) return { lineStart: i + 1, lineEnd: i + 1 };
  }
  const head = target.slice(0, Math.min(8, target.length));
  const tail = target.slice(-Math.min(8, target.length));
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const t = norm(lines[i]);
    if (start === -1 && t.includes(head)) start = i + 1;
    if (t.includes(tail)) end = i + 1;
  }
  if (start !== -1 && end !== -1 && end >= start) return { lineStart: start, lineEnd: end };
  return { lineStart: 1, lineEnd: 1 };
}

/** 文件内容 → file 通道提案卡（archive.ts 同源规则抽候选句 + 行区间证据） */
function proposalsFromFileContent(content: string, srcPath: string): SedimentProposal[] {
  const out: SedimentProposal[] = [];
  for (const entry of extractArchives(content, '')) {
    const range = locateLineRange(content, entry.dialog);
    out.push(fileProposalOf(entry, srcPath, { path: srcPath, lineStart: range.lineStart, lineEnd: range.lineEnd }));
    if (out.length >= PROPOSALS_PER_RESULT) break;
  }
  return out;
}

/** search 命中行（`path:行号: 内容`）→ file 通道提案卡（证据 = 命中文件路径 + 行号） */
function proposalsFromSearchHits(content: string): SedimentProposal[] {
  const out: SedimentProposal[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^(.+?):(\d+):\s?(.*)$/.exec(line);
    if (!m) continue;
    const hitPath = m[1];
    const lineNo = Number(m[2]);
    const hitText = m[3];
    if (!hitPath || !Number.isFinite(lineNo) || lineNo < 1 || !hitText.trim()) continue;
    for (const entry of extractArchives(hitText, '')) {
      out.push(
        fileProposalOf(entry, hitPath, { path: hitPath, lineStart: lineNo, lineEnd: lineNo }),
      );
      if (out.length >= PROPOSALS_PER_RESULT) return out;
    }
  }
  return out;
}

/**
 * 从本轮读类工具结果 + 回复提取画像提案卡（含抽屉/提炼/source/evidence 行区间/置信度）。
 * - dialog 通道：userText/assistantText 走既有 extractArchives（S-5 修复后含回复）→ 用户自述提案
 *   （偏好/身份 → profile 抽屉；其余 → insights 抽屉，落盘时按 type 走 sectionOf 映射）；
 * - file 通道：读类工具结果走同一套规则 → insights 提案卡（铁律：source:file 永不进 profile）；
 * - 两通道提案按（type+提炼信息相似）去重合并；提案产出 emit memory_write(action:'propose')。
 */
export async function proposeFromTurn(input: SedimentInput): Promise<SedimentProposal[]> {
  const proposals: SedimentProposal[] = [];
  // 1) dialog 通道：用户自述（userText 优先，assistantText 回复中转述/复述同样纳入）
  for (const entry of extractArchives(input.userText ?? '', input.assistantText ?? '')) {
    proposals.push({
      drawer: entry.type === '偏好' || entry.type === '身份' ? 'profile' : 'insights',
      insight: entry.insight,
      source: 'dialog',
      confidence: entry.confidence,
      type: entry.type,
      dialog: entry.dialog,
      tags: entry.tags,
    });
  }
  // 2) file 通道：读类工具结果（只读内容进提案通道，绝不直接归档）
  for (const tr of input.toolResults ?? []) {
    if (!tr || typeof tr.tool !== 'string' || !READ_TOOLS.has(tr.tool)) continue;
    const content = String(tr.content ?? '').slice(0, PROPOSAL_CONTENT_LIMIT);
    if (!content.trim()) continue;
    const isSearch = tr.tool === 'search_vault' || tr.tool === 'search_memory' || tr.tool === 'vault_search';
    const batch = isSearch
      ? proposalsFromSearchHits(content)
      : proposalsFromFileContent(content, tr.path ?? '');
    for (const p of batch) {
      if (proposals.some((prev) => similarProposal(prev, p))) continue;
      proposals.push(p);
    }
  }
  if (proposals.length > 0) emitSedimentEvent('propose');
  return proposals;
}

// ===== 确认闸 =====

let sedimentConfirmHandler: SedimentConfirmHandler | null = null;

/** 安装确认桩（测试/宿主注入；null 摘除）。同写闸 setWriteConfirmHandler 模式。 */
export function setSedimentConfirmHandler(handler: SedimentConfirmHandler | null): void {
  sedimentConfirmHandler = handler ?? null;
}

/** 提案卡清单渲染（TTY confirm 弹卡用；只含提炼/来源/证据定位，不携带文件全文） */
export function renderProposals(proposals: SedimentProposal[]): string {
  const lines = proposals.slice(0, 10).map((p, i) => {
    const ev = p.evidence
      ? `，证据 ${path.basename(p.evidence.path)}#L${p.evidence.lineStart}-L${p.evidence.lineEnd}`
      : '';
    return `- [${i + 1}] ${p.drawer}｜source:${p.source}${ev}｜置信度 ${p.confidence}：${p.insight}`;
  });
  const more = proposals.length > 10 ? `\n（其余 ${proposals.length - 10} 条略）` : '';
  return `画像沉淀提案（共 ${proposals.length} 条；source:file 只入 insights/patterns.md，永不进 profile）：\n${lines.join('\n')}${more}`;
}

/**
 * 确认四级解析（同写闸 KS-7.15 顺序）：
 * ① 注入确认桩（setSedimentConfirmHandler）→ 直接采信；② isMock=true → 未确认；
 * ③ stdin TTY → inquirer confirm（默认取消）一次；④ 其他非交互 → 未确认。
 */
export async function resolveSedimentConfirm(
  proposals: SedimentProposal[],
  opts: { isMock?: boolean; isTTY?: boolean } = {},
): Promise<boolean> {
  if (sedimentConfirmHandler) {
    return (await sedimentConfirmHandler(proposals)) === true;
  }
  if (opts.isMock) return false;
  if (opts.isTTY) {
    // 经表现层转发（避免核心层出现渲染库字面 import；inquirer confirm 缺省即取消）
    const { ask } = await import('./utils/ui');
    const answer = await ask(`${renderProposals(proposals)}\n是否沉淀以上画像提案？`, 'confirm');
    return answer === true;
  }
  return false;
}

// ===== 落盘 =====

/** 提案卡 → 标准归档条目；铁律编码点：source:file 一律「模式」→ insights/patterns.md（drawer 声明不生效）。未知来源返回 null（拒绝） */
function entryOfProposal(p: SedimentProposal): ArchiveEntry | null {
  if (p.source === 'file') {
    const ev = p.evidence;
    const dialog = ev
      ? `（source:file）${ev.path}#L${ev.lineStart}-L${ev.lineEnd}${p.dialog ? ` 原句：${p.dialog}` : ''}`
      : '（source:file）';
    return {
      type: '模式',
      dialog,
      insight: p.insight,
      confidence: p.confidence,
      tags: ['#模式', '#source:file'],
    };
  }
  if (p.source === 'dialog') {
    const type = proposalType(p);
    return {
      type,
      dialog: p.dialog || p.insight,
      insight: p.insight,
      confidence: p.confidence,
      tags: p.tags ?? ['#个人'],
    };
  }
  return null;
}

/**
 * 确认后逐条落盘（cli 接线消费）：source:file → appendArchive(insights)（铁律强制）；
 * source:dialog → 按提案类型走 sectionOf 映射；未知来源拒绝（零写入）。
 * 每条 accept/reject 各 emit memory_write（action:'accept'|'reject'）。
 */
export function applyProposals(
  proposals: SedimentProposal[],
  store: MemoryStore,
): ApplyProposalsResult {
  const accepted: SedimentProposal[] = [];
  const rejected: SedimentProposal[] = [];
  const files = new Set<string>();
  for (const p of proposals) {
    const entry = entryOfProposal(p);
    if (!entry) {
      rejected.push(p);
      continue;
    }
    const section = sectionOfType(entry.type);
    const relFile = ARCHIVE_REL_TARGETS[entry.type];
    store.appendArchive(section, entry);
    files.add(relFile);
    emitSedimentEvent('accept', section, relFile);
    accepted.push(p);
  }
  return { accepted, rejected, files: [...files] };
}

/**
 * 确认 → 落盘一条龙（cli 接线入口）：四级确认 → applyProposals(store)；
 * 未确认零写入并 emit memory_write(action:'reject')。
 */
export async function confirmAndApply(
  proposals: SedimentProposal[],
  store: MemoryStore,
  opts: { isMock?: boolean; isTTY?: boolean } = {},
): Promise<ConfirmApplyResult> {
  if (proposals.length === 0) {
    return { confirmed: false, accepted: [], rejected: [], files: [] };
  }
  const confirmed = await resolveSedimentConfirm(proposals, opts);
  if (!confirmed) {
    emitSedimentEvent('reject');
    return { confirmed: false, accepted: [], rejected: [...proposals], files: [] };
  }
  const res = applyProposals(proposals, store);
  return { confirmed: true, ...res };
}

// ===== commitSediment（独立入口：指定 historyDir 直写） =====

/** 与 src/memory/store.ts 同款清洗（安全红线 5：转义 < >、折叠换行），两端勿漂移 */
function sanitizeForMarkdown(text: string): string {
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 与 src/memory/store.ts formatArchiveEntry 同格式的条目块（store 未导出格式化器，勿漂移） */
function formatEntryBlock(entry: ArchiveEntry): string {
  const lines = [
    `### [归档类型：${entry.type}]`,
    '',
    `- **原始对话片段**：<dialog>"${sanitizeForMarkdown(entry.dialog)}"</dialog>`,
    `- **提炼信息**：${sanitizeForMarkdown(entry.insight)}`,
    `- **置信度**：${entry.confidence}`,
    `- **关联标签**：${entry.tags.map((tag) => '`#' + tag.replace(/^#/, '') + '`').join(' ')}`,
  ];
  if (entry.conflict) {
    lines.push(`- <conflict>${sanitizeForMarkdown(entry.conflict)}</conflict>`);
  }
  return lines.join('\n');
}

/** 本地时区 YYYY-MM-DD（与 store 口径一致） */
function localDate(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 向指定 historyDir 追加一条归档（`## YYYY-MM-DD` 日期标题与当日合并逻辑同 store.appendArchive） */
function appendEntryToHistoryDir(historyDir: string, relTarget: string, entry: ArchiveEntry): void {
  const filePath = path.join(historyDir, relTarget);
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    // 文件不存在则新建
  }
  const headerRe = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(content)) !== null) last = m[1];
  const date = localDate();
  const block = last === date ? `${formatEntryBlock(entry)}\n` : `## ${date}\n\n${formatEntryBlock(entry)}\n`;
  const base =
    content === '' ? '' : content.endsWith('\n\n') ? content : content.endsWith('\n') ? `${content}\n` : `${content}\n\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, base + block, 'utf8');
}

/** commitSediment 用：以指定 historyDir 为根的 MemoryStore 适配器（appendArchive 直写；其余 no-op） */
function directStoreFor(historyDir: string): MemoryStore {
  return {
    ensureStructure: (): void => {},
    load: async () => ({ profile: {}, importantDates: null, patterns: null, journal: null, recentSessions: [] }),
    appendArchive: (_section: MemorySection, entry: ArchiveEntry): void => {
      appendEntryToHistoryDir(historyDir, ARCHIVE_REL_TARGETS[entry.type], entry);
    },
    appendSessionLog: (): void => {},
  };
}

/**
 * 确认闸 + 落盘（独立入口，测试/离线脚本用）：确认四级解析 → 全部经 applyProposals
 * （source:file 只落 insights/patterns.md，落盘条目含 `source:file` 与 `evidence: <path>#L<start>-L<end>`）；
 * 任一拒绝/未确认 → 零写入（含不创建目录）。
 */
export async function commitSediment(
  proposals: SedimentProposal[],
  opts: CommitSedimentOptions,
): Promise<CommitSedimentResult> {
  const res = await confirmAndApply(proposals, directStoreFor(opts.historyDir), {
    isMock: opts.isMock,
    isTTY: Boolean(process.stdin.isTTY),
  });
  return { written: res.files, confirmed: res.confirmed };
}
