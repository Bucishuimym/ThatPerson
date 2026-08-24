/**
 * Present 元认知系统（第三版提示词 · 六；第 5 期批次一：主目录/随身目录级联）
 * Present = Agent 的「出厂设置」（我是谁 / 我的风格 / 我的准则 / 我的输出习惯 / 我的能力清单）。
 * 级联：主目录 ~/.thatperson/present/ 为基线 → 随身目录 <cwd>/.thatperson/present/ 覆盖同名文件 → 包内出厂补齐；
 * history/（真实长期记忆）所在目录由 config.memoryRoot 决定，不在此处。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureConfigDir, localThatPersonDir } from './config';

/** present/ 目录名（相对主目录/随身目录） */
const PRESENT_DIR = 'present';

/** 包内出厂 present/（dist/src 上溯 2 级到包根；发布后 = node_modules/@nineteenfolk/thatperson/present） */
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

/** 读取 present/ 内容：主目录基线 + 随身目录覆盖，按文件名排序拼接；目录缺失返回空串 */
export function loadPresent(rootDir: string = process.cwd()): string {
  const { home } = ensureConfigDir();
  const files = new Map<string, string>();
  // 主目录 ~/.thatperson/present/（全局基线）
  collectDirFiles(path.join(home, PRESENT_DIR), files);
  // 随身目录 <cwd>/.thatperson/present/（同名覆盖主目录；独有文件保留）
  const local = localThatPersonDir(rootDir);
  if (local) {
    collectDirFiles(path.join(local, PRESENT_DIR), files);
  }

  // 包内出厂兑底：主目录/随身目录缺失的文件名用出厂人格补齐（同名优先主/随身，不覆盖）
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

/** 将包内出厂 present/*.md 模板复制到目标 present 目录（已存在不覆盖） */
export function presentInit(targetHome: string): { written: string[]; skipped: string[] } {
  const targetDir = path.join(targetHome, PRESENT_DIR);
  fs.mkdirSync(targetDir, { recursive: true });
  const written: string[] = [];
  const skipped: string[] = [];
  let packageFiles: string[];
  try {
    packageFiles = fs.readdirSync(PACKAGE_PRESENT_DIR).filter((f) => f.endsWith('.md'));
  } catch {
    return { written, skipped };
  }
  for (const file of packageFiles.sort()) {
    const target = path.join(targetDir, file);
    if (fs.existsSync(target)) {
      skipped.push(file);
      continue;
    }
    try {
      fs.copyFileSync(path.join(PACKAGE_PRESENT_DIR, file), target);
      written.push(file);
    } catch {
      skipped.push(file);
    }
  }
  return { written, skipped };
}

/** 当前生效人格全文（等效 loadPresent()，供 status/show 等使用） */
export function presentShowText(): string {
  return loadPresent();
}

/** 将 Present 内容组织为 System 消息（带边界标签，防注入） */
export function buildPresentBlock(presentText: string): string {
  if (!presentText.trim()) return '';
  return `<present>\n${presentText}\n</present>`;
}
