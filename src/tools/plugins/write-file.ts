/**
 * write_file 插件工具（第 7 期批次一 · task 3；KS-7.7 / KS-7.8 / DD-7.1）
 *
 * - write / L1，恒注册（builtin.ts 接线）；
 * - params：path(必填) / content(必填) / mode(create|overwrite|append，默认 create)；
 * - 校验链 = 红线文件名（isRedlinedName：.env* / *api-key* / *.key / .gitignore → redline-denied 无解锁）
 *   → assertPathAllowed（→ path-denied）→ 覆盖分档（KS-7.8）：
 *   create 且存在 → conflict 结构化拒绝；overwrite 且存在 → TTY 经写确认闸确认（默认取消），
 *   非交互结构化拒绝 conflict；append 不存在则创建；
 * - 写前转义 < >（SEC-2 防标签闭合），保留换行（DD-7.1：通用写文件折行会损毁内容，有意取舍）；
 * - mkdirSync recursive 建父目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertPathAllowed } from '../guards';
import { resolveWriteConfirm } from '../write-gate';
import type { ToolContext, ToolDef, ToolHandlerResult } from '../types';

/** 敏感文件名红线：.env* / *api-key* / *.key / .gitignore 一律拒绝写入（复用 edit-vault-note 口径） */
function isRedlinedName(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.') || lower.startsWith('.env-')) return true;
  if (lower.includes('api-key')) return true;
  if (lower.endsWith('.key')) return true;
  if (lower === '.gitignore') return true;
  return false;
}

/** 读取文件，不存在返回 null */
function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** 内容清洗（DD-7.1）：只转义 < > 防标签闭合，保留换行（与记忆条目折行口径不同，有意取舍） */
function escapeAngleKeepNewlines(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const writeFileDef: ToolDef = {
  name: 'write_file',
  description:
    '把文本内容写入指定文件：mode=create（默认，已存在拒绝）/overwrite（存在时需确认）/append（追加，缺失则建）。敏感文件（.env/API-key/*.key/.gitignore）拒绝。write 操作。',
  params: [
    { name: 'path', type: 'string', required: true, description: '目标文件路径（须在允许目录内）' },
    { name: 'content', type: 'string', required: true, description: '要写入的文本内容' },
    {
      name: 'mode',
      type: 'string',
      required: false,
      enum: ['create', 'overwrite', 'append'],
      description: '写入模式，默认 create',
    },
  ],
  policy: 'write',
  riskLevel: 'L1',
  handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const pathRaw = String(args.path).trim();
    const contentRaw = String(args.content);
    const mode = typeof args.mode === 'string' && args.mode ? args.mode : 'create';

    // ① 红线优先（KS-35：敏感文件永远拒绝，无解锁路径）
    const basename = path.basename(pathRaw);
    if (isRedlinedName(basename)) {
      return { ok: false, error: `redline-denied: 敏感文件不可写入：${basename}` };
    }
    // ② 路径白名单
    const safe = assertPathAllowed(pathRaw, ctx.allowedRoots);
    if (!safe) return { ok: false, error: 'path-denied' };

    const exists = fs.existsSync(safe);
    // ③ 覆盖分档（KS-7.8）
    if (mode === 'create' && exists) {
      return { ok: false, error: 'conflict: 目标已存在' };
    }
    if (mode === 'overwrite' && exists) {
      // TTY → 写确认闸确认（默认取消）；非交互（管道/--mock/--input-file）→ 结构化拒绝
      const approved = await resolveWriteConfirm(
        { kind: 'structural', entries: [{ tool: 'write_file', source: '（覆盖既有文件）', target: pathRaw }] },
        { isMock: false, isTTY: Boolean(process.stdin.isTTY) },
      );
      if (!approved) return { ok: false, error: 'conflict: 目标已存在且未获覆盖确认' };
    }

    // ④ 写前转义（保留换行）
    const content = escapeAngleKeepNewlines(contentRaw);
    try {
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      if (mode === 'append') {
        const existing = readIfExists(safe) ?? '';
        let next = existing;
        if (next && !next.endsWith('\n')) next += '\n';
        next += content.endsWith('\n') ? content : `${content}\n`;
        fs.writeFileSync(safe, next, 'utf8');
      } else {
        // create（不存在）与 overwrite（已确认）：整文件写入
        fs.writeFileSync(safe, content, 'utf8');
      }
    } catch (err) {
      return { ok: false, error: `write-failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const verb = mode === 'append' ? '已追加写入' : mode === 'overwrite' ? '已覆盖写入' : '已写入';
    return { ok: true, content: `${verb} ${pathRaw}` };
  },
};
