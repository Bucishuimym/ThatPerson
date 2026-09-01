/**
 * PARA 初始仓库（第 7 期批次二 · KS-7.26 / T7）
 *
 * 职责：vault 根解析 + PARA 仓库首启生成（幂等）。
 * - 根解析：THATPERSON_VAULT_ROOT 优先，缺省 ~/.thatperson/vault（THATPERSON_HOME 隔离下为 <home>/vault）；
 * - ensureParaVault()：五目录（0-Inbox/Projects/Areas/Resources/Archives）+ 顶层 README.md（含 PARA 结构说明）
 *   + 每目录 1 个占位说明 .md；已存在不重建不覆盖（幂等），返回 { root, created }；
 * - 零依赖（node:fs/node:path + config 的 thatPersonHome）；任何模式首启自动建（--version/--help 不建，接线归 cli main()）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { thatPersonHome } from './config';

/** PARA 五目录（固定顺序；供生成与测试枚举） */
export const PARA_DIRS = ['0-Inbox', 'Projects', 'Areas', 'Resources', 'Archives'] as const;

/** 各 PARA 目录的占位说明文件名（每目录恰好 1 个 .md，wb-5 断言依据） */
const PARA_PLACEHOLDER_FILE: Record<(typeof PARA_DIRS)[number], string> = {
  '0-Inbox': '收件箱说明.md',
  Projects: '项目说明.md',
  Areas: '领域说明.md',
  Resources: '资源说明.md',
  Archives: '归档说明.md',
};

/** 各占位说明文件的内容（一两句说明该目录用途） */
const PARA_PLACEHOLDER_TEXT: Record<(typeof PARA_DIRS)[number], string> = {
  '0-Inbox':
    '# 收件箱\n\n所有未整理的想法、笔记与文件先进这里；定期清空，归类到 Projects / Areas / Resources / Archives。\n',
  Projects: '# 项目\n\n有明确目标与完成时间的进行中事项；完成后移入 Archives 归档。\n',
  Areas: '# 领域\n\n需要长期维护的责任领域（如健康、财务、家庭）；没有截止日期，但需持续投入。\n',
  Resources: '# 资源\n\n未来可能用到的参考资料与素材，按主题存放。\n',
  Archives: '# 归档\n\n已完成的项目与不再活跃的内容沉淀于此，仅供备查。\n',
};

/** 顶层 README.md 内容（含 PARA 结构说明与每个目录的用途） */
const PARA_README_TEXT = [
  '# ThatPerson PARA 记忆仓库',
  '',
  '本目录按 PARA 方法组织个人文件，由 ThatPerson 首次启动自动生成（幂等，不覆盖已有内容）。',
  '',
  '## PARA 结构',
  '',
  '- 0-Inbox：收件箱，所有未整理输入先进这里',
  '- Projects：进行中的项目（有明确目标与完成时间）',
  '- Areas：长期维护的责任领域（健康 / 财务 / 家庭等）',
  '- Resources：参考资料与素材',
  '- Archives：已完成与不再活跃内容的归档',
  '',
  '## 用法',
  '',
  '新内容先入 0-Inbox，定期整理到其余四目录；可在 ThatPerson web 工作台（thatperson web）',
  '浏览与编辑这些文件（需 thatperson open <目录> 授权后访问）。',
  '',
].join('\n');

/**
 * vault 根解析（纯函数）：THATPERSON_VAULT_ROOT 环境变量优先（resolve 为绝对路径），
 * 缺省 <THATPERSON_HOME>/vault（即 ~/.thatperson/vault，THATPERSON_HOME 可隔离重定向）。
 */
export function vaultRoot(): string {
  const env = process.env.THATPERSON_VAULT_ROOT?.trim();
  if (env) return path.resolve(env);
  return path.join(thatPersonHome(), 'vault');
}

/** ensureParaVault 返回：root = vault 根；created = 本次是否实际创建（首启 true，已存在幂等 false） */
export interface ParaVaultResult {
  root: string;
  created: boolean;
}

/**
 * 首启生成 PARA 仓库（幂等）：五目录 + 顶层 README.md（含 PARA 结构说明字样）+ 每目录 1 个占位说明 .md。
 * 已存在不重建不覆盖：二次调用 created=false，既有文件内容与 mtime 不变。
 */
export function ensureParaVault(): ParaVaultResult {
  const root = vaultRoot();
  // created 语义：本次调用是否实际创建（PARA 结构有缺失 → 本次补齐即视为创建；已齐备 → 幂等 false）
  // 已存在的目录/文件一律不重建不覆盖（existsSync 逐项判断，mtime 不变）。
  const created =
    PARA_DIRS.some((dir) => !fs.existsSync(path.join(root, dir))) || !fs.existsSync(path.join(root, 'README.md'));
  fs.mkdirSync(root, { recursive: true });
  for (const dir of PARA_DIRS) {
    const dirPath = path.join(root, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath);
    }
    // 每目录 1 个占位说明 .md（一两句用途说明；已存在不覆盖）
    const placeholderPath = path.join(dirPath, PARA_PLACEHOLDER_FILE[dir]);
    if (!fs.existsSync(placeholderPath)) {
      fs.writeFileSync(placeholderPath, PARA_PLACEHOLDER_TEXT[dir], 'utf8');
    }
  }
  // 顶层 README.md：PARA 结构与用法说明（已存在不覆盖——用户改过不应被重建）
  const readmePath = path.join(root, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, PARA_README_TEXT, 'utf8');
  }
  return { root, created };
}
