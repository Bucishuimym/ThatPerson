/**
 * Present 元认知系统（第二版提示词 · 二）
 * Present = Agent 的「出厂设置」（我是谁 / 我的风格 / 我的准则 / 我的输出习惯）
 * 与 history/（后天记忆）相互独立；每次对话开始前读取并拼接到 System 消息最前。
 */
import fs from 'node:fs';
import path from 'node:path';

/** present/ 目录（相对项目根） */
const PRESENT_DIR = 'present';

/** 读取 present/ 下全部 .md 文件，按文件名排序拼接；目录缺失时返回空串（降级为无元认知） */
export function loadPresent(rootDir: string = process.cwd()): string {
  const dir = path.resolve(rootDir, PRESENT_DIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8').trim();
    if (content) parts.push(content);
  }
  return parts.join('\n\n');
}

/** 将 Present 内容组织为 System 消息（带边界标签，防注入） */
export function buildPresentBlock(presentText: string): string {
  if (!presentText.trim()) return '';
  return `<present>\n${presentText}\n</present>`;
}