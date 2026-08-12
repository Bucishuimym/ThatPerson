/**
 * Present 元认知系统（第三版提示词 · 二/六）
 * Present = Agent 的「出厂设置」（我是谁 / 我的风格 / 我的准则 / 我的输出习惯）
 * 用户级 ~/.thatperson/present/ 为全局人格基线；项目 present/ 可覆盖同名文件；
 * history/（真实长期记忆）始终在项目目录下，不入用户目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureConfigDir, isProjectMode } from './config';

/** 项目 present/ 目录（相对项目根） */
const PRESENT_DIR = 'present';

/** 包内出厂 present/（dist/src 上溯 3 级到包根；发布后 = node_modules/@nineteenfolk/thatperson/present） */
const PACKAGE_PRESENT_DIR = path.join(__dirname, '..', '..', 'present');

/** 收集目录下全部 .md 文件内容：文件名 -> 路径 */
function collectDirFiles(dir: string, target: Map<string, string>): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return;
  }
  for (const file of files) {
    target.set(file, path.join(dir, file));
  }
}

/** 读取 present/ 内容：用户级基线 + 项目级覆盖，按文件名排序拼接；目录缺失返回空串 */
export function loadPresent(rootDir: string = process.cwd()): string {
  const { home } = ensureConfigDir();
  const files = new Map<string, string>();
  // 用户级 ~/.thatperson/present/（全局基线）
  collectDirFiles(path.join(home, 'present'), files);
  // 项目 present/（同名覆盖用户级；独有文件保留；仅项目模式生效）
  if (isProjectMode(rootDir)) {
    collectDirFiles(path.resolve(rootDir, PRESENT_DIR), files);
  }

  // 包内出厂兑底：用户级/项目级缺失的文件名用出厂人格补齐（同名优先用户/项目，不覆盖）
  try {
    const packageFiles = fs.readdirSync(PACKAGE_PRESENT_DIR).filter((f) => f.endsWith('.md'));
    for (const file of packageFiles) {
      if (!files.has(file)) files.set(file, path.join(PACKAGE_PRESENT_DIR, file));
    }
  } catch {
    // 包内出厂目录不存在（如源码直跑时无 dist）则跳过
  }
  const parts: string[] = [];
  for (const file of Array.from(files.keys()).sort()) {
    try {
      const content = fs.readFileSync(files.get(file) as string, 'utf8').trim();
      if (content) parts.push(content);
    } catch {
      // 文件读取失败跳过
    }
  }
  return parts.join('\n\n');
}

/** 将 Present 内容组织为 System 消息（带边界标签，防注入） */
export function buildPresentBlock(presentText: string): string {
  if (!presentText.trim()) return '';
  return `<present>\n${presentText}\n</present>`;
}