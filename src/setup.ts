/**
 * 首次配置向导（第 5 期 · KS-8）
 *
 * `thatperson setup` 入口：引导输入 API Key 与模型，写回 config.json。
 * - 打印 thatPersonHome() 与 config.json 路径；
 * - inquirer v14 ESM-only，动态导入（沿用 utils/ui.ts 的 S-09 约定）；
 * - Key 用 password 类型输入：掩码、不打印、不落日志；
 * - 写回保留既有字段，新增 apiKey + configured: true（0600）。
 *
 * 依赖边界：只 import config.ts 与 node 模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODEL, ensureConfigDir, thatPersonHome } from './config';

export interface SetupWizardResult {
  ok: boolean;
  error?: string;
}

/** 读取既有 config.json：不存在时返回默认结构；损坏/非对象时返回 null（拒绝覆盖） */
function readExistingConfig(configPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(configPath)) {
    return { model: DEFAULT_MODEL, disabledSkills: [], configured: false };
  }
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

/**
 * 运行首次配置向导：交互收集 API Key 与模型，写回 config.json。
 * Key 输入不可见、不回显、不落日志；config.json 0600 写盘。
 */
export async function runSetupWizard(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { configPath } = ensureConfigDir();
    console.log('[ThatPerson] 首次配置向导');
    console.log(`全局目录：${thatPersonHome()}`);
    console.log(`配置文件：${configPath}`);
    console.log('');

    const { default: inquirer } = await import('inquirer');

    const keyAnswer = (await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: '请输入 DeepSeek API Key（输入不可见，不会回显或写入日志）：',
        validate: (v: string) => (v && v.trim().length > 0) || 'API Key 不能为空',
      },
    ])) as { apiKey: string };
    const apiKey = keyAnswer.apiKey.trim();

    const modelAnswer = (await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useDefault',
        message: `是否使用默认模型 ${DEFAULT_MODEL}？`,
        default: true,
      },
    ])) as { useDefault: boolean };

    let model = DEFAULT_MODEL;
    if (!modelAnswer.useDefault) {
      const modelInput = (await inquirer.prompt([
        {
          type: 'input',
          name: 'model',
          message: '请输入模型名称：',
          default: DEFAULT_MODEL,
        },
      ])) as { model: string };
      model = modelInput.model.trim() || DEFAULT_MODEL;
    }

    // 写回 config.json：保留既有字段，新增 apiKey + configured: true（0600，POSIX 生效）
    const current = readExistingConfig(configPath);
    if (current === null) {
      return { ok: false, error: 'config.json 已存在但无法解析，请人工修复后重试（拒绝覆盖）' };
    }
    current.model = model;
    current.apiKey = apiKey;
    current.configured = true;
    fs.writeFileSync(configPath, `${JSON.stringify(current, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    console.log('');
    console.log(`[ThatPerson] 配置已写入：${configPath}`);
    console.log('[ThatPerson] API Key 已安全保存（掩码存储、不回显），模型：' + model);
    console.log('[ThatPerson] 首次配置完成，现在可以开始使用了。');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Prompt closed') || message.includes('User force closed')) {
      return { ok: false, error: '已取消配置向导' };
    }
    return { ok: false, error: message };
  }
}
