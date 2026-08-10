/**
 * 全局配置与目录管理（第三版提示词 · 六，第 3 期补充：记忆目录定位）
 *
 * ~/.thatperson/：config.json / present/ / skills/ / logs/ / history/
 * 记忆目录定位（发布 npm 包后仍保证「一个 Agent、一份记忆」）：
 *   1) THATPERSON_MEMORY_DIR 显式指定（指向 history 所在目录）；
 *   2) 项目模式（cwd 即本项目）：<cwd>/history/，保持本地开发习惯；
 *   3) 全局部署模式（任意目录运行）：~/.thatperson/history/。
 * 支持 THATPERSON_HOME 自定义全局目录；ensureConfigDir 已存在不覆盖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认模型（config.json 缺省值） */
export const DEFAULT_MODEL = 'deepseek-v4-flash';

export interface ThatPersonConfig {
  model: string;
}

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
    fs.writeFileSync(configPath, `${JSON.stringify({ model: DEFAULT_MODEL }, null, 2)}\n`, 'utf8');
  }
  return { home, configPath };
}

/** 读取配置（缺失/损坏时回退默认，不覆盖既有文件） */
export function loadConfig(): ThatPersonConfig {
  const { configPath } = ensureConfigDir();
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<ThatPersonConfig>;
    return { model: typeof raw.model === 'string' && raw.model ? raw.model : DEFAULT_MODEL };
  } catch {
    return { model: DEFAULT_MODEL };
  }
}

/**
 * 项目模式判定：cwd 即本项目（package.json name 匹配，或存在本项目源码特征）。
 * 用于区分「本地开发（记忆入项目）」与「全局部署（记忆入用户目录）」。
 */
export function isProjectMode(cwd: string = process.cwd()): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { name?: string };
    const name = (pkg.name ?? '').toLowerCase();
    if (name === 'thatperson') return true;
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