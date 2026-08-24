#!/usr/bin/env node
/**
 * ThatPerson 持续对话 CLI（第 4 期 · S-01/S-02/S-05/S-06/S-07/S-09/S-10/S-14）
 *
 * 用法：npm run chat（或 --mock 离线演示）；全局安装后任意目录输入 thatperson
 * 第 4 期新增（D-3a CLI 内核）：
 * - S-01 全局参数解析：--version/-V、--help/-h、--mock、--input-file（修复 Bug 1：不再误入对话）；
 * - S-02 内部指令表：/help /history /clear /reset /exit /save /update（优先于 Skill，不送 LLM）；
 * - S-05 指令-执行-返回：/check directory 与自然语言「检查工作目录」真正执行并回传 LLM；
 * - S-06 能力自省行为化：Skill 触发不再打印 SKILL.md 原文，改一行摘要 + 内部注入 LLM；
 * - S-07/S-08 更新检查：启动异步 checkForUpdates，12h 缓存落 thatPersonHome()，全部失败静默；
 * - S-09/S-10 UI 接入：showBanner 启动一次、status 卡片接真实数据；
 * - S-14 LLM 语义归档：llmExtractArchives/mergeArchives 动态接线，缺失/出错降级规则版。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chat, loadEnv, sectionOf, today, foldSummary, SYSTEM_TOKEN_BUDGET, type ChatMessage } from './chat';
import { loadPresent, presentInit, presentShowText } from './present';
import { createMemoryStore, countArchiveEntries, compactMemoryFile } from './memory/store';
import {
  type ArchiveEntry,
  type MemorySection,
  type MemoryStore,
  SECTION_FILES,
} from './memory/types';
import { extractArchives, buildSessionSummary, detectCrossTurnPatterns, extractContentModeArchives } from './parser/archive';
import {
  ensureConfigDir,
  loadConfig,
  memoryRoot,
  resolveHistoryDir,
  thatPersonHome,
  getConfigValue,
  setConfigValue,
  CONFIG_KEY_WHITELIST,
  listDisabledSkills,
  disableSkill,
  enableSkill,
  hasApiKey,
  resolveApiKey,
  maskApiKey,
  isConfigured,
  resetConfig,
  type ConfigKey,
} from './config';
import { runSetupWizard } from './setup';
import { runAgentLoop } from './agent/loop';
import { listTools } from './tools/registry';
import { registerBuiltins } from './tools/builtin';
import { listSkills, matchSkill, type SkillInfo } from './skill';
import { logger, showBanner, showStatusCard } from './utils/ui';
import { checkForUpdates, readCurrentVersion, shouldSkipUpdateCheck } from './utils/update-check';

const EXIT_CMDS = new Set(['exit', 'quit', '退出', '再见']);
/** 超过该条数后开始折叠最早轮次（保留最近 4 轮 = 8 条） */
const HISTORY_LIMIT = 8;
/** 检索源：最近 2 轮用户话（3b） */
const RECENT_WINDOW = 2;
/** 跨轮模式观察窗口：最近 6 轮（3c） */
const PATTERN_WINDOW = 6;

/** 当前支持的工具指令（指令-执行-返回通道白名单，S-05） */
const TOOL_COMMANDS = new Set(['check']);

/** LLM 语义归档模块（D-1 按 KeySpecs S-13/S-14 实现）；本文件动态接线，缺失时降级规则版 */
const LLM_ARCHIVE_MODULE = './parser/llm-archive';
/** 摘要折叠安全转义（FZ-4b/SEC-9）：用户/助手原文中的 < > 转义，防止提前闭合 <早前对话摘要> 边界 */
function escapeTags(text: string): string {
  return (text ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


// ===== 会话状态 =====

export interface SessionState {
  history: ChatMessage[];
  summary: string;
  recentUserTexts: string[];
}

export interface ParsedArgs {
  isMock: boolean;
  inputFile: string | null;
  /** 全局子命令（positional[0]），如 status / update */
  command: string | null;
  commandArgs: string[];
  showVersion: boolean;
  showHelp: boolean;
  unknownArgs: string[];
}

// ===== 全局参数解析（S-01 + S-03 未知参数）=====

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const out: ParsedArgs = {
    isMock: false,
    inputFile: null,
    command: null,
    commandArgs: [],
    showVersion: false,
    showHelp: false,
    unknownArgs: [],
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--mock') {
      out.isMock = true;
    } else if (a === '--version' || a === '-V') {
      out.showVersion = true;
    } else if (a === '--help' || a === '-h') {
      out.showHelp = true;
    } else if (a === '--input-file') {
      const value = args[i + 1];
      if (value && !value.startsWith('-')) {
        out.inputFile = value;
        i += 1;
      } else {
        out.unknownArgs.push(a);
      }
    } else if (a.startsWith('--input-file=')) {
      out.inputFile = a.slice('--input-file='.length);
    } else if (a.startsWith('-')) {
      out.unknownArgs.push(a);
    } else {
      positional.push(a);
    }
  }
  if (!out.showVersion && !out.showHelp && positional.length > 0) {
    out.command = positional[0];
    out.commandArgs = positional.slice(1);
  }
  return out;
}

// ===== 内部指令（S-02）=====

export function formatHelp(): string {
  return [
    'ThatPerson CLI 帮助',
    '',
    '全局参数（thatperson ...）：',
    '  thatperson                     进入持续对话模式',
    '  thatperson --mock              离线演示模式（不调用 API、不发网络）',
    '  thatperson --input-file <path> 从文件读入指令（UTF-8，单次对话后退出）',
    '  thatperson --version / -V      输出版本号后退出',
    '  thatperson --help / -h         显示本帮助后退出',
    '',
    '全局指令（thatperson <子命令>）：',
    '  status      显示系统状态卡片（版本/模型/记忆/技能/Token 预算/目录）',
    '  update      手动检查更新（绕过 12h 缓存；THATPERSON_DEV 开发模式仍跳过）',
    '  setup       首次配置向导（输入 API Key 与模型，写回 config.json）',
    '  wizard      setup 的别名',
    '  reset       重置配置（仅保留 apiKey 与 model；--keep-present 保留 present 覆盖）',
    '  present init  生成出厂人格模板到主目录 present/（不覆盖既有文件）',
    '  present show  查看当前生效人格',
    '  tools list    列出已注册工具（read/write/danger）',
    '  memory search <关键词>  在记忆中搜索关键词',
    '  memory stats            显示记忆统计（分 section 条目数）',
    '  memory clean            对归档文件执行压缩清理',
    '  session list            列出历史会话（session_logs）',
    '  session clear           清空当前内存会话',
    '  config get [key]        查看配置（model / disabledSkills / apiKey，apiKey 掩码回显）',
    '  config set <key> <val>  修改配置（apiKey 掩码回显）',
    '  skills list             列出已安装技能与启用状态',
    '  skills enable|disable <名称>  启用/禁用技能',
    '  help                    显示本帮助',
    '',
    '内部指令（对话内输入，不发送给模型）：',
    '  /help       显示内部指令帮助',
    '  /history    查看当前会话消息数与最近 2 轮摘要',
    '  /clear      清空终端屏幕（不影响会话）',
    '  /reset      重置当前会话（清空历史/摘要/近期输入，不落盘）',
    '  /save       将当前会话保存为快照（history/sessions/，不覆盖同名文件）',
    '  /exit       退出程序',
    '  /update     手动检查更新（绕过 12h 缓存；跳过策略仍生效）',
    '',
    'Skill：输入 /<技能名> 直接调用；自然语言命中 trigger_keywords / description 自动触发。',
    '退出对话：exit / quit / 退出 / 再见',
  ].join('\n');
}

/** /history：当前会话消息数 + 最近 2 轮摘要（S-02） */
export function formatHistory(history: ChatMessage[]): string {
  const lines = [`当前会话共有 ${history.length} 条消息。`];
  if (history.length > 0) {
    lines.push('最近 2 轮：');
    const recent = history.slice(-Math.min(history.length, 4));
    for (let i = 0; i < recent.length; i += 2) {
      const u = recent[i];
      const a = recent[i + 1];
      if (u) lines.push(`  用户：${u.content}`);
      if (a) lines.push(`  ThatPerson：${a.content}`);
    }
  }
  return lines.join('\n');
}

/** /reset：清空历史 / 摘要 / 近期输入三处（S-02，不落盘） */
export function resetSession(session: SessionState): void {
  session.history.length = 0;
  session.summary = '';
  session.recentUserTexts.length = 0;
}

/** /save：把当前会话序列化为快照写入 history/sessions/（不得覆盖已存在同名文件，S-02） */
export function saveSessionSnapshot(session: SessionState, historyDir: string): string {
  const sessionsDir = path.join(historyDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const now = new Date();
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const content = [
    `# 会话快照 · ${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`,
    '',
    `- 消息数：${session.history.length}`,
    '',
    '## 对话记录',
    '',
    ...session.history.flatMap((m) => [
      `**${m.role === 'user' ? '用户' : 'ThatPerson'}**：${m.content}`,
      '',
    ]),
  ].join('\n');

  const writeSnapshot = (target: string): string | null => {
    try {
      fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
  };

  let file = path.join(sessionsDir, `session-${stamp}.md`);
  let written = writeSnapshot(file);
  let i = 1;
  while (written === null) {
    file = path.join(sessionsDir, `session-${stamp}-${i}.md`);
    written = writeSnapshot(file);
    i += 1;
  }
  return written;
}

// ===== 指令-执行-返回通道（S-05）=====

/** 自然语言工具意图识别（白名单：只支持检查目录等有限指令，杜绝「答应+虚构动作」） */
export function detectToolIntent(text: string): { command: string; args: string } | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  if (/(检查|查看|看看)/.test(t) && /(工作|当前)?目录/.test(t)) {
    return { command: 'check', args: 'directory' };
  }
  if (/(列出目录|目录内容|目录里有什么)/.test(t)) {
    return { command: 'check', args: 'directory' };
  }
  return null;
}

/** 统一执行通道：内部指令 / Skill 执行 / 工具调用共用（S-05）；仅白名单内可执行，失败返回诚实文本 */
export async function runTool(command: string, args: string, cwd = process.cwd()): Promise<string> {
  const cmd = (command ?? '').toLowerCase().trim();
  const arg = (args ?? '').trim();
  if (cmd === 'check') {
    if (arg === '' || ['directory', 'dir', '目录', '工作目录'].includes(arg.toLowerCase())) {
      return listDirectoryContents(cwd);
    }
    return '（暂不支持该检查项，目前仅支持：check directory）';
  }
  return '（没有可执行的指令，请说明具体需求）';
}

/** 列出目录内容（白名单：仅目录列举，不读文件内容） */
function listDirectoryContents(dir: string): string {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const names = entries.slice(0, 50).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return `目录 ${dir} 下共 ${entries.length} 项：\n${names.join('\n')}`;
  } catch (err) {
    return `（无法读取目录：${err instanceof Error ? err.message : String(err)}）`;
  }
}

// ===== LLM 语义归档动态接线（S-13/S-14）=====

interface LlmArchiveModule {
  llmExtractArchives?: (
    userText: string,
    assistantText: string,
    opts?: { isMock?: boolean },
  ) => Promise<ArchiveEntry[] | null>;
  mergeArchives?: (rules: ArchiveEntry[], llm: ArchiveEntry[]) => ArchiveEntry[];
}

/** --mock 不加载该模块、不发网络（S-14）；模块缺失/调用出错 → null（规则版兜底） */
async function llmExtractArchivesSafe(
  userText: string,
  assistantText: string,
  isMock: boolean,
): Promise<ArchiveEntry[] | null> {
  if (isMock) return null;
  try {
    const mod = (await import(LLM_ARCHIVE_MODULE)) as LlmArchiveModule;
    if (typeof mod.llmExtractArchives !== 'function') return null;
    return await mod.llmExtractArchives(userText, assistantText, { isMock });
  } catch {
    return null;
  }
}

/** mergeArchives 降级：模块缺失/出错时返回规则版结果（不阻塞对话） */
async function mergeArchivesSafe(rules: ArchiveEntry[], llm: ArchiveEntry[]): Promise<ArchiveEntry[]> {
  try {
    const mod = (await import(LLM_ARCHIVE_MODULE)) as LlmArchiveModule;
    if (typeof mod.mergeArchives !== 'function') return rules;
    return mod.mergeArchives(rules, llm);
  } catch {
    return rules;
  }
}

// ===== 单轮对话处理 =====

interface DialogContext {
  isMock: boolean;
  store: MemoryStore;
  present: string;
  session: SessionState;
  projectSkillsDirs: string[];
  skills: SkillInfo[];
  model: string;
  home: string;
  inputFile?: string | null;
}

interface TurnExtra {
  /** 已触发的 Skill（内容仅内部注入 LLM，不回显） */
  skill?: SkillInfo;
  /** 指令-执行-返回的真实结果 */
  toolResult?: string;
}

/** 处理一轮输入：内部指令 / Skill 斜杠 / 工具通道 / 自然语言（含 Skill auto + 工具意图） */
async function processInput(
  line: string,
  ctx: DialogContext,
  commands: Record<string, (args: string) => void | Promise<void>>,
): Promise<void> {
  if (line.startsWith('/')) {
    const [rawCmd, ...rest] = line.split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const handler = commands[cmd];
    if (handler) {
      await handler(rest.join(' '));
      return;
    }
    // 优先级：内部指令 > Skill 斜杠命令 > 指令-执行-返回 > 未知命令提示（S-02）
    // 斜杠按首个 token 匹配，支持 /<技能名> <参数>；参数随原输入交给 LLM
    const skillMatch = matchSkill(`/${cmd.slice(1)}`, ctx.projectSkillsDirs);
    if (skillMatch && skillMatch.via === 'slash') {
      console.log(`已加载技能「${skillMatch.skill.name}」`);
      await runLlmTurn(line, ctx, { skill: skillMatch.skill });
      return;
    }
    const toolName = cmd.slice(1);
    if (TOOL_COMMANDS.has(toolName)) {
      const toolResult = await runTool(toolName, rest.join(' '));
      await runLlmTurn(line, ctx, { toolResult });
      return;
    }
    console.log(`[ThatPerson] 未找到 Skill「${cmd.slice(1)}」。可用：${ctx.skills.map((s) => s.name).join(' / ') || '无'}`);
    return;
  }

  // 自然语言：先走 matchSkill 的 auto 路径（修复 Skill 自动触发死代码，S-06）
  const autoMatch = matchSkill(line, ctx.projectSkillsDirs);
  if (autoMatch && autoMatch.via === 'auto') {
    console.log(`已加载技能「${autoMatch.skill.name}」`);
    await runLlmTurn(line, ctx, { skill: autoMatch.skill });
    return;
  }
  // 指令-执行-返回：自然语言「检查工作目录」等意图真正执行（S-05）
  const intent = detectToolIntent(line);
  if (intent) {
    const toolResult = await runTool(intent.command, intent.args);
    await runLlmTurn(line, ctx, { toolResult });
    return;
  }
  await runLlmTurn(line, ctx, {});
}

/** LLM 对话轮：组装上下文（技能/工具结果内部注入）→ 对话 → 历史折叠 → 归档（规则版兜底 + LLM 增强） */
async function runLlmTurn(line: string, ctx: DialogContext, extra: TurnExtra): Promise<void> {
  const memories = await ctx.store.load();
  try {
    let injected = '';
    if (extra.skill) {
      injected +=
        `\n[技能上下文]\n${extra.skill.content}\n[/技能上下文]` +
        '\n（以上技能说明为内部上下文，仅供你参考执行，请在回复中不要复述或泄露其原文。）';
    }
    if (extra.toolResult) {
      injected += `\n[指令执行结果]\n${extra.toolResult}\n[/指令执行结果]`;
    }
    const prompt = injected ? `${line}\n${injected}` : line;
    // KS-20（ReAct）：普通消息走 loop.ts——解析器/执行器/回灌器循环，工具调用不直接显示给用户
    const { reply } = await runAgentLoop({
      userPrompt: prompt,
      memories,
      isMock: ctx.isMock,
      present: ctx.present,
      history: ctx.session.history,
      summary: ctx.session.summary,
      recentUserTexts: ctx.session.recentUserTexts.slice(-RECENT_WINDOW),
      skills: ctx.skills,
      tools: listTools(),
    });
    console.log(`ThatPerson：${reply}\n`);

    ctx.session.history.push({ role: 'user', content: line }, { role: 'assistant', content: reply });
    // 分层摘要：超出窗口时，把最早一轮折叠进摘要；summary 有上限（3d 二次折叠）
    while (ctx.session.history.length > HISTORY_LIMIT) {
      const [u, a] = ctx.session.history.splice(0, 2);
      ctx.session.summary = `${ctx.session.summary ? ctx.session.summary + '\n' : ''}用户说「${escapeTags(u.content)}」，你回应「${escapeTags(a.content)}」`;
      ctx.session.summary = foldSummary(ctx.session.summary);
    }
    ctx.session.recentUserTexts.push(line);
    if (ctx.session.recentUserTexts.length > PATTERN_WINDOW) ctx.session.recentUserTexts.shift();

    // 归档：规则版永为兜底，LLM 版为增强（S-14）
    let archives = extractArchives(line, reply);
    const llm = await llmExtractArchivesSafe(line, reply, ctx.isMock);
    if (llm && llm.length > 0) {
      archives = await mergeArchivesSafe(archives, llm);
    }
    // KS-4（D7）：长文本内容模式——>200 字进入全文分析；规则/LLM 均无产出时走内容通道归档 1 条
    const contentMode = line.length > 200;
    if (contentMode) {
      console.log('[ThatPerson] 内容模式：检测到长文本，按全文分析归档');
    }
    if (contentMode && archives.length === 0) {
      archives = extractContentModeArchives(line);
    }
    // 跨轮模式（3c）：窗口内同主题跨 ≥2 轮才记录，单条消息不产模式
    const crossPatterns = detectCrossTurnPatterns(ctx.session.recentUserTexts);
    for (const entry of crossPatterns) {
      ctx.store.appendArchive(sectionOf(entry), entry);
    }
    for (const entry of archives) {
      ctx.store.appendArchive(sectionOf(entry), entry);
    }
    ctx.store.appendSessionLog(
      buildSessionSummary(today(), line, reply, [...archives, ...crossPatterns]),
    );
    const archivedCount = archives.length + crossPatterns.length;
    if (archivedCount) console.log(`[ThatPerson] 已归档 ${archivedCount} 条记忆\n`);
  } catch (err) {
    console.error(`[ThatPerson] 出错：${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ===== 内部指令表（S-02）=====

interface InternalCommandCtx {
  session: SessionState;
  store: MemoryStore;
  isMock: boolean;
}

/** 内部指令表：Record<string, (args: string) => void | Promise<void>>；由 CLI 直接执行，不送 LLM */
function createInternalCommands(
  ctx: InternalCommandCtx,
): Record<string, (args: string) => void | Promise<void>> {
  return {
    '/help': (): void => {
      console.log(formatHelp());
    },
    '/history': (): void => {
      console.log(formatHistory(ctx.session.history));
    },
    '/clear': (): void => {
      console.clear();
    },
    '/reset': (): void => {
      resetSession(ctx.session);
      console.log('会话已重置');
    },
    '/exit': (): void => {
      console.log('再见 👋');
      process.exit(0);
    },
    '/save': (): void => {
      try {
        const file = saveSessionSnapshot(ctx.session, resolveHistoryDir());
        logger.success(`已保存会话快照：${file}`);
      } catch (err) {
        logger.error(`保存会话快照失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    '/update': async (): Promise<void> => {
      if (ctx.isMock) {
        logger.info('离线模式（--mock），跳过更新检查');
        return;
      }
      if (shouldSkipUpdateCheck(process.cwd())) {
        logger.info('跳过更新检查（THATPERSON_DEV 开发模式）');
        return;
      }
      logger.info('正在检查更新…');
      await checkForUpdates({ force: true });
      logger.info('更新检查完成');
    },
  };
}

// ===== 全局指令（S-03 中与 CLI 内核相关的 status/update/help）=====

/** status 卡片数据（S-10）：真实统计，禁止占位示例 */
async function runStatus(): Promise<void> {
  const store = createMemoryStore(memoryRoot());
  store.ensureStructure();
  const memories = await store.load();
  const profileCount = Object.values(memories.profile).filter((s) => s.trim()).length;
  const archiveCount = sumArchiveEntries(resolveHistoryDir());
  const memoryTotal = profileCount + archiveCount + memories.recentSessions.length;
  const skills = listSkills(defaultProjectSkillsDirs());
  showStatusCard('📊 系统状态', {
    版本: readCurrentVersion(),
    模型: loadConfig().model,
    'API Key': hasApiKey() ? maskApiKey(resolveApiKey() ?? '') : '未配置',
    记忆条目: `${memoryTotal} 条`,
    技能数量: `${skills.length} 个`,
    'Token 预算': `${SYSTEM_TOKEN_BUDGET} / 轮`,
    工作目录: process.cwd(),
    全局目录: thatPersonHome(),
  });
  logger.info('状态检查完毕');
}

/** 统计各归档文件条目数之和（profile/timeline/experiences/insights） */
export function sumArchiveEntries(historyDir: string): number {
  let total = 0;
  for (const section of Object.keys(SECTION_FILES) as MemorySection[]) {
    for (const file of SECTION_FILES[section]) {
      const p = path.join(historyDir, section, file);
      try {
        total += countArchiveEntries(fs.readFileSync(p, 'utf8'));
      } catch {
        // 文件不存在/不可读：跳过
      }
    }
  }
  return total;
}

/** 记忆统计：各 section 条目数 + 会话日志篇数（S-03 memory stats） */
export function memoryStatsText(historyDir: string): string {
  const lines: string[] = [];
  for (const section of Object.keys(SECTION_FILES) as MemorySection[]) {
    if (section === 'session_logs') continue; // 会话日志由下方独立统计
    let n = 0;
    for (const file of SECTION_FILES[section]) {
      const p = path.join(historyDir, section, file);
      try {
        n += countArchiveEntries(fs.readFileSync(p, 'utf8'));
      } catch {
        // 文件不存在/不可读：跳过
      }
    }
    lines.push(`  ${section}: ${n} 条`);
  }
  const sessionsDir = path.join(historyDir, 'session_logs');
  try {
    const n = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.md')).length;
    lines.push(`  session_logs: ${n} 篇`);
  } catch {
    lines.push('  session_logs: 0 篇');
  }
  return lines.join('\n');
}

/** 记忆搜索：对五维归档文件逐行匹配关键词（S-03 memory search） */
export function memorySearchText(historyDir: string, keyword: string): string {
  const kw = (keyword ?? '').trim();
  if (!kw) return '用法：thatperson memory search <关键词>';
  const hits: string[] = [];
  for (const section of Object.keys(SECTION_FILES) as MemorySection[]) {
    for (const file of SECTION_FILES[section]) {
      const p = path.join(historyDir, section, file);
      let content = '';
      try {
        content = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split(/\r?\n/)) {
        const t = line.trim();
        if (t && t.includes(kw)) hits.push(`  [${section}] ${t}`);
      }
    }
  }
  if (hits.length === 0) return `未找到包含「${kw}」的记忆`;
  return hits.slice(0, 30).join('\n');
}

/** 记忆清理：对全部归档文件执行压缩（去重/低置信度衰减/标签合并/软上限，S-03 memory clean） */
export function memoryCleanText(historyDir: string): string {
  let cleaned = 0;
  for (const section of Object.keys(SECTION_FILES) as MemorySection[]) {
    for (const file of SECTION_FILES[section]) {
      const p = path.join(historyDir, section, file);
      if (!fs.existsSync(p)) continue;
      try {
        compactMemoryFile(p);
        cleaned += 1;
      } catch {
        // 保留原文件，不中断
      }
    }
  }
  return `已对 ${cleaned} 个归档文件执行压缩清理`;
}

/** 会话列表：列出 session_logs 下的历史会话（S-03 session list） */
export function sessionListText(historyDir: string): string {
  const sessionsDir = path.join(historyDir, 'session_logs');
  let files: string[] = [];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.md')).sort().reverse();
  } catch {
    files = [];
  }
  if (files.length === 0) return '暂无历史会话记录';
  return files.slice(0, 20).map((f) => `  ${f}`).join('\n');
}

/** 配置查看（S-03 config get）：无 key 时输出全量，有 key 时输出单值 */
export function configGetText(key?: string): string {
  const { configPath } = ensureConfigDir();
  if (!key) {
    const cfg = loadConfig();
    const lines = [`配置文件：${configPath}`, `模型：${cfg.model}`];
    lines.push(cfg.apiKey ? `API Key：${maskApiKey(cfg.apiKey)}` : 'API Key：未设置');
    lines.push(`禁用技能：${cfg.disabledSkills?.join('、') || '（无）'}`);
    lines.push(`已配置：${isConfigured() ? '是' : '否'}`);
    return lines.join('\n');
  }
  if (key === 'apiKey') {
    const value = loadConfig().apiKey;
    return value ? maskApiKey(value) : '未设置 API Key';
  }
  const value = getConfigValue(key as ConfigKey);
  if (value === undefined) return `未设置配置键：${key}（可用：${CONFIG_KEY_WHITELIST.join('、')}）`;
  return `${key}: ${Array.isArray(value) ? value.join('、') : value}`;
}

/** 配置修改（S-03 config set） */
export function configSetText(key: string, value: string): string {
  if (!key || !value) return '用法：thatperson config set <key> <value>';
  const result = setConfigValue(key, value);
  if (!result.ok) return result.error;
  return key === 'apiKey' ? `已写入配置：apiKey（${maskApiKey(value)}）` : `已写入配置：${key}`;
}

/** 技能列表（S-03 skills list）：名称 / 描述摘要 / 启用状态 */
export function skillsListText(projectSkillsDirs: string[]): string {
  const all = listSkills(projectSkillsDirs);
  if (all.length === 0) return '未发现任何技能';
  const disabled = new Set(listDisabledSkills());
  return all
    .map((s) => `  ${s.name} ${disabled.has(s.name) ? '（已禁用）' : '（启用）'} - ${s.description.slice(0, 60)}`)
    .join('\n');
}

/** 技能启停（S-03 skills enable|disable） */
export function skillsEnableDisableText(action: 'enable' | 'disable', name: string): string {
  const skillName = (name ?? '').trim().toLowerCase();
  if (!skillName) return `用法：thatperson skills ${action} <技能名>`;
  const result = action === 'disable' ? disableSkill(skillName) : enableSkill(skillName);
  return result.ok ? `已${action === 'disable' ? '禁用' : '启用'}技能：${skillName}` : result.error;
}
/** 全局子命令分发：返回进程退出码；未知命令 → warn + 帮助 + 退出（S-03） */
export async function runGlobalCommand(
  command: string,
  args: string[],
  opts: { isMock?: boolean; projectSkillsDirs?: string[] } = {},
): Promise<number> {
  const historyDir = resolveHistoryDir();
  const skillsDirs = opts.projectSkillsDirs ?? defaultProjectSkillsDirs();
  switch (command) {
    case 'status':
      await runStatus();
      return 0;
    case 'update': {
      if (opts.isMock) {
        logger.info('离线模式（--mock），跳过更新检查');
        return 0;
      }
      if (shouldSkipUpdateCheck(process.cwd())) {
        logger.info('跳过更新检查（THATPERSON_DEV 开发模式）');
        return 0;
      }
      logger.info('正在检查更新…');
      await checkForUpdates({ force: true });
      logger.info('更新检查完成');
      return 0;
    }
    case 'help':
      console.log(formatHelp());
      return 0;
    case 'setup':
    case 'wizard': {
      const result = await runSetupWizard();
      if (!result.ok) {
        logger.warn(result.error ?? '配置向导未完成');
      }
      return 0;
    }
    case 'reset': {
      const keepPresent = args.includes('--keep-present');
      const result = resetConfig({ keepPresent });
      if (!result.ok) {
        logger.error(result.error);
        return 1;
      }
      if (!keepPresent) {
        const homePresent = path.join(thatPersonHome(), 'present');
        const removed: string[] = [];
        try {
          for (const file of fs.readdirSync(homePresent)) {
            if (file.endsWith('.md')) {
              fs.rmSync(path.join(homePresent, file));
              removed.push(file);
            }
          }
        } catch {
          // 目录不存在/不可读：跳过
        }
        if (removed.length > 0) {
          console.log(`已清除 present 覆盖：${removed.join('、')}`);
        }
      }
      console.log('已重置配置（仅保留 apiKey 与 model）。对话内 /reset 仅清会话，语义不同。');
      return 0;
    }
    case 'present': {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === 'init') {
        const { written, skipped } = presentInit(thatPersonHome());
        if (written.length > 0) console.log(`已生成人格模板：${written.join('、')}`);
        if (skipped.length > 0) console.log(`已存在未覆盖：${skipped.join('、')}`);
        if (written.length === 0 && skipped.length === 0) console.log('（无可生成的模板）');
      } else if (sub === 'show') {
        const text = presentShowText();
        console.log(text.trim() ? text : '（当前无生效人格，可运行 thatperson present init 生成模板）');
      } else {
        logger.warn('用法：thatperson present init | show');
        return 1;
      }
      return 0;
    }
    case 'tools': {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === 'list') {
        const tools = listTools();
        if (tools.length === 0) {
          console.log('（无已注册工具）');
        } else {
          const lines = tools.map((t) => {
            const params = t.params.map((p) => `${p.name}${p.required ? '' : '?'}`).join(',');
            return `  ${t.name}（${t.policy}，${params}）：${t.description.slice(0, 60)}`;
          });
          console.log(`已注册工具（${tools.length} 个）：\n${lines.join('\n')}`);
        }
      } else {
        logger.warn('用法：thatperson tools list');
        return 1;
      }
      return 0;
    }
    case 'memory': {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === 'stats') {
        console.log(memoryStatsText(historyDir));
      } else if (sub === 'search') {
        console.log(memorySearchText(historyDir, args.slice(1).join(' ')));
      } else if (sub === 'clean') {
        console.log(memoryCleanText(historyDir));
      } else {
        logger.warn('用法：thatperson memory search <关键词> | stats | clean');
        return 1;
      }
      return 0;
    }
    case 'session': {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === 'list') {
        console.log(sessionListText(historyDir));
      } else if (sub === 'clear') {
        console.log('全局命令模式下没有活动中的会话（可在持续对话内用 /reset 清空当前会话）');
      } else {
        logger.warn('用法：thatperson session list | clear');
        return 1;
      }
      return 0;
    }
    case 'config': {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === 'get') {
        console.log(configGetText(args[1]));
      } else if (sub === 'set') {
        console.log(configSetText(args[1], args[2] ?? ''));
      } else {
        logger.warn('用法：thatperson config get [key] | set <key> <value>');
        return 1;
      }
      return 0;
    }
    case 'skills': {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === 'list') {
        console.log(skillsListText(skillsDirs));
      } else if (sub === 'enable' || sub === 'disable') {
        console.log(skillsEnableDisableText(sub, args[1] ?? ''));
      } else {
        logger.warn('用法：thatperson skills list | enable <名称> | disable <名称>');
        return 1;
      }
      return 0;
    }
    default:
      logger.warn(`未知命令：thatperson ${command}`);
      console.log(formatHelp());
      return 1;
  }
}
// ===== 入口（S-01）=====

function defaultProjectSkillsDirs(): string[] {
  // KS-12：移除 .claude/skills 概念；出厂技能库（包内 skills/）由 skill.ts 级联兜底
  return [path.resolve(__dirname, '..', '..', 'skills')];
}

async function main(): Promise<void> {
  loadEnv();
  // KS-7（D9）：目录生成时机上移——任何一次调用（含 --version/--help）都保证 ~/.thatperson/ 存在
  ensureConfigDir();
  // KS-17：工具注册表初始化（danger 工具默认不注册）
  registerBuiltins();
  const args = parseArgs(process.argv);

  // Bug 1 修复：--version / -V 输出版本后退出，不再进入对话（S-01）
  if (args.showVersion) {
    console.log(readCurrentVersion());
    process.exit(0);
  }
  // --help / -h：打印内部 + 全局指令帮助后退出（S-01）
  if (args.showHelp) {
    console.log(formatHelp());
    process.exit(0);
  }
  if (args.unknownArgs.length > 0) {
    logger.warn(`未知参数：${args.unknownArgs.join(' ')}`);
    console.log(formatHelp());
    process.exit(1);
  }

  const config = loadConfig();
  const store = createMemoryStore(memoryRoot());
  store.ensureStructure();
  const present = loadPresent();
  const projectSkillsDirs = defaultProjectSkillsDirs();

  // 全局子命令（S-03 中 status/update/help 由 CLI 内核提供）
  if (args.command) {
    const code = await runGlobalCommand(args.command, args.commandArgs, { isMock: args.isMock, projectSkillsDirs });
    process.exit(code);
  }

  // KS-8（D11）：无 Key 且未 configured → 进入对话前自动引导 setup；非交互（管道/输入文件）不弹
  if (!args.isMock && !args.inputFile && process.stdin.isTTY && !hasApiKey() && !isConfigured()) {
    const setupResult = await runSetupWizard();
    if (!setupResult.ok) {
      logger.warn(setupResult.error ?? '配置向导未完成，可稍后运行 thatperson setup');
    } else {
      logger.success('首次配置完成');
    }
  }

  // 更新检查：启动时异步调用，静默失败；--mock 不发网络（S-07/S-08/SEC-7）
  if (!args.isMock) {
    checkForUpdates().catch(() => {});
  }

  const session: SessionState = { history: [], summary: '', recentUserTexts: [] };
  const skills = listSkills(projectSkillsDirs);
  await runDialog({
    isMock: args.isMock,
    store,
    present,
    session,
    projectSkillsDirs,
    skills,
    model: config.model,
    home: thatPersonHome(),
    inputFile: args.inputFile,
  });
}

async function runDialog(ctx: DialogContext): Promise<void> {
  // 横幅一次接入（S-09）：持续对话模式只刷一次，避免每轮刷屏
  showBanner(readCurrentVersion());
  console.log('[ThatPerson] 持续对话模式已开启' + (ctx.isMock ? '（离线演示，不调用 API）' : ''));
  console.log(`[ThatPerson] 全局目录：${ctx.home} ｜ 默认模型：${ctx.model}`);
  console.log(`[ThatPerson] 记忆目录：${resolveHistoryDir()}`);
  // KS-13（D12）：主目录 present/ 无任何 .md 时提醒初始化
  try {
    const homePresent = path.join(ctx.home, 'present');
    const hasUserPresent =
      fs.existsSync(homePresent) && fs.readdirSync(homePresent).some((f) => f.endsWith('.md'));
    if (!hasUserPresent) {
      console.log(
        '[ThatPerson] 当前使用出厂人格。可运行 thatperson present init 生成模板，或直接告诉我你的偏好、称呼与定位。',
      );
    }
  } catch {
    // 目录不可读：忽略
  }
  if (ctx.skills.length) {
    console.log(
      `[ThatPerson] 已发现 Skill：${ctx.skills.map((s) => s.name).join(' / ')}（输入 /<名称> 直接调用，命中关键词自动触发）`,
    );
  }
  console.log('[ThatPerson] 输入 /help 查看内部指令；exit / quit / 退出 / 再见 结束对话\n');

  const commands = createInternalCommands({
    session: ctx.session,
    store: ctx.store,
    isMock: ctx.isMock,
  });

  // --input-file：从文件读入指令（UTF-8，剥离 BOM），单次对话后退出（S-01/Task 7）
  if (ctx.inputFile) {
    let content: string;
    try {
      content = fs.readFileSync(ctx.inputFile, 'utf8').replace(/^\uFEFF/, '').trim();
    } catch (err) {
      logger.error(`无法读取输入文件：${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    if (!content) {
      logger.warn('输入文件为空，未产生对话');
      return;
    }
    await processInput(content, ctx, commands);
    return;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  while (true) {
    let line: string;
    try {
      line = ((await rl.question('你：')) ?? '').trim();
    } catch {
      break; // 输入流关闭（如管道 EOF）
    }
    if (!line) continue;
    if (EXIT_CMDS.has(line)) break;
    await processInput(line, ctx, commands);
  }
  rl.close();
  console.log('[ThatPerson] 已退出，期待下次聊天～');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}