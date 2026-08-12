/**
 * 全局配置与目录管理（第三版提示词 · 六，第 3 期补充：记忆目录定位）
 *
 * ~/.thatperson/：config.json / present/ / skills/ / logs/ / history/
 * 记忆目录定位（发布 npm 包后仍保证「一个 Agent、一份记忆」）：
 *   1) THATPERSON_MEMORY_DIR 显式指定（指向 history 所在目录）；
 *   2) 项目模式（cwd 即本项目）：<cwd>/history/，保持本地开发习惯；
 *   3) 全局部署模式（任意目录运行）：~/.thatperson/history/。
 * 支持 THATPERSON_HOME 自定义全局目录；ensureConfigDir 已存在不覆盖。
 *
 * 第 4 期（D-3b）：
 * - 模型唯一来源：config.model（默认 deepseek-v4-flash），chat.ts 实际请求模型以 loadConfig().model 为准；
 * - config get/set：key 白名单 = model / disabledSkills；set 写回保留其他字段、不静默覆盖既有文件；
 * - skills 启停：config.json 新增 disabledSkills: string[]，配套 disableSkill/enableSkill/listDisabledSkills；
 * - 首次部署 api-key 引导：apiKeyGuidance()（只提示写入 .env 的 AAGENTDS_API_KEY，不硬编码、不落日志 Key）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认模型（config.json 缺省值；模型唯一来源，chat.ts 请求模型以 loadConfig().model 为准） */
export const DEFAULT_MODEL = 'deepseek-v4-flash';

/** config get/set 可写键白名单（S-03）：model + disabledSkills */
export const CONFIG_KEY_WHITELIST = ['model', 'disabledSkills'] as const;
export type ConfigKey = (typeof CONFIG_KEY_WHITELIST)[number];

export interface ThatPersonConfig {
  model: string;
  disabledSkills: string[];
}

/** config 写回结果：{ ok: true } 或 { ok: false, error } */
export type SetConfigResult = { ok: true } | { ok: false; error: string };

/** 统一路径来源：THATPERSON_HOME > ~/.thatperson */
export function thatPersonHome(): string {
  return process.env.THATPERSON_HOME?.trim() || path.join(os.homedir(), '.thatperson');
}

/** 启动时调用：递归创建 ~/.thatperson 子目录并写默认 config.json（已存在不覆盖） */
export function ensureConfigDir(): { home: string; configPath: string } {
  const home = thatPersonHome();
  for (const sub of ['', 'present', 'skills', 'logs']) {
    fs.mkdirSync(path.join(home, sub), { recursive: true });
  }
  const configPath = path.join(home, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `${JSON.stringify({ model: DEFAULT_MODEL, disabledSkills: [] }, null, 2)}\n`, 'utf8');
  }
  return { home, configPath };
}

/** 归一化技能名：小写、去首斜杠（与 skill.ts 的 SkillInfo.name 小写约定一致） */
function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/^\/+/, '');
}

/** 读取配置（缺失/损坏时回退默认，不覆盖既有文件） */
export function loadConfig(): ThatPersonConfig {
  const { configPath } = ensureConfigDir();
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<ThatPersonConfig>;
    const disabledSkills = Array.isArray(raw.disabledSkills)
      ? raw.disabledSkills.filter((x): x is string => typeof x === 'string' && x.length > 0).map(normalizeSkillName)
      : [];
    return {
      model: typeof raw.model === 'string' && raw.model ? raw.model : DEFAULT_MODEL,
      disabledSkills: [...new Set(disabledSkills)],
    };
  } catch {
    return { model: DEFAULT_MODEL, disabledSkills: [] };
  }
}

/** 读配置文件中单个白名单键的值（供 `thatperson config get <key>` 使用；无键时用 loadConfig() 全量输出） */
export function getConfigValue(key: ConfigKey): string | string[] | undefined {
  return loadConfig()[key];
}

/**
 * 写回 config.json（`thatperson config set <key> <value>`）：
 * - key 必须 ∈ CONFIG_KEY_WHITELIST（model / disabledSkills），value 非空字符串；
 * - disabledSkills 支持 JSON 字符串数组或逗号/顿号分隔；
 * - 读-改-写：保留其他字段；config.json 已存在但无法解析时拒绝写回（不静默覆盖既有文件）。
 */
export function setConfigValue(key: string, value: string): SetConfigResult {
  if (!(CONFIG_KEY_WHITELIST as readonly string[]).includes(key)) {
    return { ok: false, error: `不支持的配置键：${key}（可用：${CONFIG_KEY_WHITELIST.join('、')}）` };
  }
  const v = value.trim();
  if (!v) return { ok: false, error: '配置值不能为空' };
  const { configPath } = ensureConfigDir();
  const current = readExistingConfig(configPath);
  if (current === null) {
    return { ok: false, error: 'config.json 已存在但无法解析，请人工修复后再试（拒绝静默覆盖）' };
  }
  if (key === 'model') {
    current.model = v;
  } else {
    current.disabledSkills = parseSkillList(v);
  }
  return writeConfig(configPath, current);
}

/** 解析 disabledSkills 输入：JSON 字符串数组，或逗号/顿号/空白分隔（去重、小写、过滤空项） */
function parseSkillList(value: string): string[] {
  let items: string[] = [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) items = parsed.map((x) => String(x));
  } catch {
    items = value.split(/[,，、\s]+/);
  }
  return [...new Set(items.map(normalizeSkillName).filter((x) => x.length > 0))];
}

/** 读取既有 config.json：不存在时返回默认结构；存在但解析失败/非对象时返回 null（拒绝覆盖） */
function readExistingConfig(configPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(configPath)) return { model: DEFAULT_MODEL, disabledSkills: [] };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** 写回 config.json（格式化 JSON + 换行） */
function writeConfig(configPath: string, config: Record<string, unknown>): SetConfigResult {
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `写入 config.json 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 当前已禁用的技能名列表（小写、去重） */
export function listDisabledSkills(): string[] {
  return loadConfig().disabledSkills;
}

/** 禁用技能：持久化写入 disabledSkills（幂等） */
export function disableSkill(name: string): SetConfigResult {
  const target = normalizeSkillName(name);
  if (!target) return { ok: false, error: '技能名不能为空' };
  return updateDisabledSkills((list) => (list.includes(target) ? list : [...list, target]));
}

/** 启用技能：从 disabledSkills 移除（幂等） */
export function enableSkill(name: string): SetConfigResult {
  const target = normalizeSkillName(name);
  if (!target) return { ok: false, error: '技能名不能为空' };
  return updateDisabledSkills((list) => list.filter((x) => x !== target));
}

/** 技能是否已禁用（大小写不敏感） */
export function isSkillDisabled(name: string): boolean {
  const target = normalizeSkillName(name);
  return target.length > 0 && listDisabledSkills().includes(target);
}

/** 读-改-写 disabledSkills（保留其他字段；损坏文件拒绝覆盖） */
function updateDisabledSkills(mutate: (current: string[]) => string[]): SetConfigResult {
  const { configPath } = ensureConfigDir();
  const current = readExistingConfig(configPath);
  if (current === null) {
    return { ok: false, error: 'config.json 已存在但无法解析，请人工修复后再试（拒绝静默覆盖）' };
  }
  const existing = Array.isArray(current.disabledSkills)
    ? (current.disabledSkills as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  current.disabledSkills = mutate(existing.map(normalizeSkillName));
  return writeConfig(configPath, current);
}

/**
 * 项目模式判定：cwd 即本项目（package.json name 匹配，或存在本项目源码特征）。
 * 用于区分「本地开发（记忆入项目）」与「全局部署（记忆入用户目录）」。
 */
export function isProjectMode(cwd: string = process.cwd()): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { name?: string };
    const name = (pkg.name ?? '').toLowerCase();
    if (name === 'thatperson' || name === '@nineteenfolk/thatperson') return true;
  } catch {
    // 无 package.json 时继续按源码特征判定
  }
  return fs.existsSync(path.join(cwd, 'src', 'parser', 'archive.ts'));
}

/** 返回包含 history/ 的记忆根目录（见文件头优先级规则） */
export function memoryRoot(cwd: string = process.cwd()): string {
  const explicit = process.env.THATPERSON_MEMORY_DIR?.trim();
  if (explicit) return path.dirname(path.resolve(explicit));
  if (isProjectMode(cwd)) return cwd;
  return thatPersonHome();
}

/** 返回长期记忆目录（history 所在目录，实际存储位置） */
export function resolveHistoryDir(cwd: string = process.cwd()): string {
  return path.join(memoryRoot(cwd), 'history');
}
/** 是否已配置 API Key（仅读环境变量 AAGENTDS_API_KEY，不读写文件、不落日志） */
export function hasApiKey(): boolean {
  return Boolean(process.env.AAGENTDS_API_KEY?.trim());
}

/**
 * 首次部署无 Key 引导文案（must_do 11 / S-03）。
 * 提示写入项目根 .env 的 AAGENTDS_API_KEY（.env 已 gitignore），或稍后用 config 指令配置；
 * 不硬编码任何 Key、不落日志 Key。
 */
export function apiKeyGuidance(): string {
  return [
    '未检测到 API Key（环境变量 AAGENTDS_API_KEY）。',
    '请任选一种方式完成配置后重新启动：',
    '  1) 在项目根目录 .env 中添加：AAGENTDS_API_KEY=你的Key（.env 已被 gitignore，勿提交到仓库）；',
    '  2) 或稍后通过 `thatperson config set <key> <value>` 等指令配置（详见 `thatperson --help`）。',
  ].join('\n');
}
