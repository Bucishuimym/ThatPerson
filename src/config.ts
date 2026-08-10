/**
 * 全局配置与目录管理（第三版提示词 · 六）
 * ~/.thatperson/：config.json / identity.md / present/ / skills/ / logs/
 * 支持 THATPERSON_HOME 环境变量；ensureConfigDir 已存在不覆盖。
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