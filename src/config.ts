/**
 * 全局配置与目录管理（第三版提示词 · 六，第 3 期补充：记忆目录定位；第 5 期批次一：首次部署闭环 + Key 同源 + 主/随身目录）
 *
 * ~/.thatperson/：config.json / present/ / skills/ / logs/ / history/
 * 记忆目录定位（发布 npm 包后仍保证「一个 Agent、一份记忆」）：
 *   1) THATPERSON_MEMORY_DIR 显式指定（指向 history 所在目录）；
 *   2) 随身目录模式（cwd/.thatperson 存在）：<cwd>/.thatperson/history/；
 *   3) 主目录模式（任意目录运行）：~/.thatperson/history/。
 * 支持 THATPERSON_HOME 自定义全局目录；ensureConfigDir 已存在不覆盖。
 *
 * 第 4 期（D-3b）：
 * - 模型唯一来源：config.model（默认 deepseek-v4-flash），chat.ts 实际请求模型以 loadConfig().model 为准；
 * - config get/set：key 白名单 = model / disabledSkills / apiKey；set 写回保留其他字段、不静默覆盖既有文件；
 * - skills 启停：config.json 新增 disabledSkills: string[]，配套 disableSkill/enableSkill/listDisabledSkills。
 *
 * 第 5 期（批次一）：
 * - KS-7：ensureConfigDir 子目录补 history/（已存在不覆盖）；
 * - KS-9/KS-10：apiKey 进白名单；resolveApiKey 同源（环境变量 > config.json.apiKey > 包目录 .env，.env 由 loadEnv 载入）；
 *   config.json 写盘 0600；maskApiKey 掩码；apiKeyGuidance 指向 thatperson setup 向导；
 * - KS-11：config.json 首次创建含 configured:false；isConfigured() / resetConfig()（reset 仅保留 model+apiKey）；
 * - KS-12：取消「项目级/用户级」二元，改为「主目录 ~/.thatperson → 随身目录 cwd/.thatperson → 包内兜底」。
 *
 * 第 6 期（批次二 · KS-39/KS-40）：
 * - allowedDirs 进 CONFIG_KEY_WHITELIST（get 可读）；config set 白名单不含它（禁止对话/命令行越权写入）；
 * - allowDir/denyDir：绝对路径 + 存在目录 + realpath 复检（符号链接/junction 逃逸拒绝）+ 写回 0600；
 * - denyDir 对称移除、幂等；resetConfig 保留 allowedDirs 且显式写 configured:false。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认模型（config.json 缺省值；模型唯一来源，chat.ts 请求模型以 loadConfig().model 为准） */
export const DEFAULT_MODEL = 'deepseek-v4-flash';

/** 配置键白名单（S-03 / KS-9 / KS-40）：model + disabledSkills + apiKey + allowedDirs */
export const CONFIG_KEY_WHITELIST = ['model', 'disabledSkills', 'apiKey', 'allowedDirs'] as const;
export type ConfigKey = (typeof CONFIG_KEY_WHITELIST)[number];

/** config set 可写键（KS-40：allowedDirs 只经 allowDir/denyDir 授权写入，set 白名单不含它） */
const CONFIG_SET_KEY_WHITELIST: readonly string[] = ['model', 'disabledSkills', 'apiKey'];

export interface ThatPersonConfig {
  model: string;
  disabledSkills: string[];
  /** API Key（掩码存储于 config.json；旧文件无此字段时缺省 undefined，不静默改写文件） */
  apiKey?: string;
  /** 是否已完成首次配置（向导/写入 apiKey 时置 true；旧文件缺省 false） */
  configured?: boolean;
  /** 授权目录白名单（KS-39/KS-40：绝对路径、去重；仅 allowDir/denyDir 维护） */
  allowedDirs?: string[];
}

/** config 写回结果：{ ok: true } 或 { ok: false, error } */
export type SetConfigResult = { ok: true } | { ok: false; error: string };

/** 统一路径来源：THATPERSON_HOME > ~/.thatperson */
export function thatPersonHome(): string {
  return process.env.THATPERSON_HOME?.trim() || path.join(os.homedir(), '.thatperson');
}

/** 启动时调用：递归创建 ~/.thatperson 子目录并写默认 config.json（已存在不覆盖；config.json 首次写盘 0600） */
export function ensureConfigDir(): { home: string; configPath: string } {
  const home = thatPersonHome();
  for (const sub of ['', 'present', 'skills', 'logs', 'history']) {
    fs.mkdirSync(path.join(home, sub), { recursive: true });
  }
  const configPath = path.join(home, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ model: DEFAULT_MODEL, disabledSkills: [], configured: false }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }
  return { home, configPath };
}

/** 归一化技能名：小写、去首斜杠（与 skill.ts 的 SkillInfo.name 小写约定一致） */
function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/^\/+/, '');
}

/** 读取配置（缺失/损坏时回退默认，不覆盖既有文件；旧文件无 apiKey/configured 时给缺省值但不静默改写） */
export function loadConfig(): ThatPersonConfig {
  const { configPath } = ensureConfigDir();
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<ThatPersonConfig>;
    const disabledSkills = Array.isArray(raw.disabledSkills)
      ? raw.disabledSkills.filter((x): x is string => typeof x === 'string' && x.length > 0).map(normalizeSkillName)
      : [];
    const allowedDirs = Array.isArray(raw.allowedDirs)
      ? [...new Set(
          raw.allowedDirs
            .filter((x): x is string => typeof x === 'string' && path.isAbsolute(x))
            .map((p) => path.resolve(p)),
        )]
      : [];
    return {
      model: typeof raw.model === 'string' && raw.model ? raw.model : DEFAULT_MODEL,
      disabledSkills: [...new Set(disabledSkills)],
      apiKey: typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : undefined,
      configured: raw.configured === true,
      allowedDirs,
    };
  } catch {
    return { model: DEFAULT_MODEL, disabledSkills: [], allowedDirs: [] };
  }
}

/** 读配置文件中单个白名单键的值（供 `thatperson config get <key>` 使用；无键时用 loadConfig() 全量输出） */
export function getConfigValue(key: ConfigKey): string | string[] | undefined {
  return loadConfig()[key];
}

/**
 * 写回 config.json（`thatperson config set <key> <value>`）：
 * - key 必须 ∈ CONFIG_SET_KEY_WHITELIST（model / disabledSkills / apiKey），value 非空字符串；
 * - allowedDirs 不在 set 白名单内：授权目录只能经 allowDir/denyDir 写入（KS-40）；
 * - disabledSkills 支持 JSON 字符串数组或逗号/顿号分隔；
 * - apiKey 写入后自动置 configured: true（与 setup 向导口径一致）；
 * - 读-改-写：保留其他字段；config.json 已存在但无法解析时拒绝写回（不静默覆盖既有文件）。
 */
export function setConfigValue(key: string, value: string): SetConfigResult {
  if (!CONFIG_SET_KEY_WHITELIST.includes(key)) {
    return { ok: false, error: `不支持的配置键：${key}（可用：${CONFIG_SET_KEY_WHITELIST.join('、')}）` };
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
  } else if (key === 'apiKey') {
    current.apiKey = v;
    current.configured = true;
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

/** 写回 config.json（格式化 JSON + 换行；0600 权限，POSIX 生效） */
function writeConfig(configPath: string, config: Record<string, unknown>): SetConfigResult {
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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

// ===== 第 6 期批次二 · allow-dir / deny-dir 授权目录（KS-39/KS-40） =====

/** Windows 路径比较忽略大小写（realpath 归一对比） */
function samePath(a: string, b: string): boolean {
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** 读当前 allowedDirs（绝对路径、去重；损坏/缺失为空数组） */
function currentAllowedDirs(config: Record<string, unknown>): string[] {
  const list = Array.isArray(config.allowedDirs)
    ? (config.allowedDirs as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return [...new Set(list.map((p) => path.resolve(p)))];
}

/** 当前授权目录列表（KS-39：status / 审计展示用） */
export function listAllowedDirs(): string[] {
  return loadConfig().allowedDirs ?? [];
}

/**
 * 授权目录（KS-39/KS-41 注入防护）：严格校验——
 * 1) path.isAbsolute(raw) 否则拒绝；
 * 2) raw 按 / 与 \ 分段不得含 '..'；
 * 3) 目标必须存在且为目录；
 * 4) fs.realpathSync(resolved) 与 path.resolve(resolved) 不一致（符号链接/junction 逃逸）拒绝；
 * 5) 已存在幂等返回 ok；写回 config.json（保留其他字段，0600）。
 * 对话注入载荷（附加文本/相对路径/..）一律无法通过校验（SEC-b2）。
 */
export function allowDir(raw: string): SetConfigResult {
  const input = (raw ?? '').trim();
  if (!input) return { ok: false, error: '路径不能为空' };
  if (!path.isAbsolute(input)) return { ok: false, error: '仅支持绝对路径' };
  if (input.split(/[\\/]/).includes('..')) return { ok: false, error: '路径不能包含 .. 段' };
  const resolved = path.resolve(input);
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(resolved);
    stat = fs.statSync(real);
  } catch {
    return { ok: false, error: '目录不存在或不可访问' };
  }
  if (!stat.isDirectory()) return { ok: false, error: '目标不是目录' };
  if (!samePath(real, resolved)) {
    return { ok: false, error: '符号链接/软链路径不接受，请使用真实路径' };
  }
  const { configPath } = ensureConfigDir();
  const current = readExistingConfig(configPath);
  if (current === null) {
    return { ok: false, error: 'config.json 已存在但无法解析，请人工修复后再试（拒绝静默覆盖）' };
  }
  const next = currentAllowedDirs(current);
  if (!next.some((d) => samePath(d, resolved))) next.push(resolved);
  current.allowedDirs = next;
  return writeConfig(configPath, current);
}

/**
 * 撤销授权目录（KS-40 对称移除）：以 realpath 归一后删除对应条目；
 * 未授权/不存在/非法输入一律幂等返回 ok；保留其余授权。
 */
export function denyDir(raw: string): SetConfigResult {
  const input = (raw ?? '').trim();
  let canonical: string | null = null;
  if (input && path.isAbsolute(input) && !input.split(/[\\/]/).includes('..')) {
    const resolved = path.resolve(input);
    try {
      canonical = fs.realpathSync(resolved);
    } catch {
      canonical = resolved;
    }
  }
  const { configPath } = ensureConfigDir();
  const current = readExistingConfig(configPath);
  if (current === null) {
    return { ok: false, error: 'config.json 已存在但无法解析，请人工修复后再试（拒绝静默覆盖）' };
  }
  const next = currentAllowedDirs(current).filter((d) => {
    if (canonical === null) return true; // 非法输入：不改动任何条目（幂等 ok）
    let storedReal: string;
    try {
      storedReal = fs.realpathSync(d);
    } catch {
      storedReal = d;
    }
    return !samePath(storedReal, canonical);
  });
  current.allowedDirs = next;
  return writeConfig(configPath, current);
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
 * 随身目录判定（KS-12）：cwd/.thatperson 目录存在时返回其绝对路径，否则 null。
 * 用于「主目录 ~/.thatperson → 随身目录 cwd/.thatperson → 包内兜底」的级联定位。
 */
export function localThatPersonDir(cwd: string = process.cwd()): string | null {
  const dir = path.resolve(cwd, '.thatperson');
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  } catch {
    // 路径不可访问时视为不存在
  }
  return null;
}

/**
 * 兼容导出（KS-12）：旧「项目模式」语义已替换为「随身目录」判定。
 * 保留导出以避免破坏既有调用方；内部实现 = localThatPersonDir。
 */
export function isProjectMode(cwd: string = process.cwd()): boolean {
  return localThatPersonDir(cwd) !== null;
}

/** 返回包含 history/ 的记忆根目录（优先级：THATPERSON_MEMORY_DIR > 随身目录 cwd/.thatperson > 主目录 ~/.thatperson） */
export function memoryRoot(cwd: string = process.cwd()): string {
  const explicit = process.env.THATPERSON_MEMORY_DIR?.trim();
  if (explicit) return path.dirname(path.resolve(explicit));
  const local = localThatPersonDir(cwd);
  if (local) return local;
  return thatPersonHome();
}

/** 返回长期记忆目录（history 所在目录，实际存储位置） */
export function resolveHistoryDir(cwd: string = process.cwd()): string {
  return path.join(memoryRoot(cwd), 'history');
}

/**
 * API Key 同源解析（KS-9/KS-10）：环境变量 AAGENTDS_API_KEY > config.json.apiKey > 包目录 .env。
 * 包目录 .env 由 chat.ts/cli.ts 的 loadEnv 载入 process.env（不覆盖既有环境变量），此处天然满足；
 * 本函数不直接读写 .env，不打印、不落日志 Key。
 */
export function resolveApiKey(): string | undefined {
  const envKey = process.env.AAGENTDS_API_KEY?.trim();
  if (envKey) return envKey;
  const cfgKey = loadConfig().apiKey?.trim();
  return cfgKey || undefined;
}

/** 是否已配置 API Key（走 resolveApiKey 同源，不打印、不落日志） */
export function hasApiKey(): boolean {
  return Boolean(resolveApiKey());
}

/** Key 掩码：仅保留末 4 位（如 sk-***abcd）；不足 4 位尾数时统一 sk-***；空串返回空串 */
export function maskApiKey(key: string): string {
  const clean = key.trim();
  if (!clean) return '';
  const tail = clean.slice(-4);
  if (tail.length < 4) return 'sk-***';
  return `sk-***${tail}`;
}

/** 是否已完成首次配置（读取 configured，缺省 false；旧文件不静默改写） */
export function isConfigured(): boolean {
  return loadConfig().configured === true;
}

/**
 * 首次部署无 Key 引导文案（KS-10）：指向 thatperson setup 向导，不再引导工作目录建 .env。
 * 不硬编码任何 Key、不落日志 Key。
 */
export function apiKeyGuidance(): string {
  return [
    '未检测到 API Key，请运行 `thatperson setup` 完成首次配置（向导会引导输入 Key 与模型）。',
    '也可以直接使用 `thatperson config set apiKey <Key>` 配置；Key 掩码存储、不回显。',
  ].join('\n');
}

/**
 * 重置配置（KS-11 / KS-40）：config.json 保留 model / apiKey / allowedDirs（授权不误清），
 * 清 disabledSkills、显式写 configured:false。
 * present 覆盖文件的清理由 cli.ts 处理，本函数只负责 config 层写回。
 */
export function resetConfig(_opts?: { keepPresent?: boolean }): SetConfigResult {
  const { configPath } = ensureConfigDir();
  const current = readExistingConfig(configPath);
  if (current === null) {
    return { ok: false, error: 'config.json 已存在但无法解析，请人工修复后再试（拒绝静默覆盖）' };
  }
  const next: Record<string, unknown> = {
    model: typeof current.model === 'string' && current.model ? current.model : DEFAULT_MODEL,
    configured: false,
  };
  const apiKey = typeof current.apiKey === 'string' ? current.apiKey.trim() : '';
  if (apiKey) next.apiKey = apiKey;
  const allowedDirs = currentAllowedDirs(current);
  if (allowedDirs.length > 0) next.allowedDirs = allowedDirs;
  return writeConfig(configPath, next);
}
