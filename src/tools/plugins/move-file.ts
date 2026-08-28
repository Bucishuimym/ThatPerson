/**
 * move_file / rename_file 插件工具（第 6 期批次一 · 能力底座口径；第 6 期批次二 · KS-34 标注 L2）
 *
 * 两者共享内部移动 helper：优先 fs.renameSync 跨目录移动，失败回退复制+删除
 * （文件 copyFileSync+unlinkSync，目录 cpSync+rmSync）。write 操作，
 * 路径一律经 assertPathAllowed 白名单校验；目标已存在拒绝覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertPathAllowed } from '../guards';
import type { ToolContext, ToolDef, ToolHandlerResult } from '../types';

/** 移动文件/目录：renameSync 失败时回退复制+删除 */
function moveEntrySync(source: string, target: string): void {
  try {
    fs.renameSync(source, target);
    return;
  } catch {
    // 跨盘/权限等场景回退复制+删除
  }
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.cpSync(source, target, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  } else {
    fs.copyFileSync(source, target);
    fs.unlinkSync(source);
  }
}

/** 共享校验/冲突/移动逻辑（move_file 与 rename_file 共用） */
function moveCore(sourceRaw: string, source: string, target: string, verb: 'move' | 'rename'): ToolHandlerResult {
  try {
    fs.statSync(source);
  } catch {
    return { ok: false, error: 'source-not-found' };
  }
  if (fs.existsSync(target)) {
    return { ok: false, error: `conflict: 目标已存在：${target}` };
  }
  try {
    moveEntrySync(source, target);
  } catch (err) {
    return { ok: false, error: `move-failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const action = verb === 'rename' ? '已重命名' : '已移动';
  return { ok: true, content: `${action} ${sourceRaw} → ${target}` };
}

export const moveFileDef: ToolDef = {
  name: 'move_file',
  description: '把文件或目录移动到目标目录：目标目录已存在同名则拒绝（不覆盖），跨目录移动失败自动回退复制+删除。write 操作，源与目标均须在允许目录内。',
  params: [
    { name: 'source', type: 'string', required: true, description: '要移动的文件或目录路径' },
    { name: 'targetDir', type: 'string', required: true, description: '目标目录路径' },
  ],
  policy: 'write',
  riskLevel: 'L2',
  handler: (args: Record<string, unknown>, ctx: ToolContext): ToolHandlerResult => {
    const sourceRaw = String(args.source);
    const source = assertPathAllowed(sourceRaw, ctx.allowedRoots);
    if (!source) return { ok: false, error: 'path-denied' };
    const targetDirRaw = String(args.targetDir);
    const targetDir = assertPathAllowed(targetDirRaw, ctx.allowedRoots);
    if (!targetDir) return { ok: false, error: 'path-denied' };
    const target = path.join(targetDir, path.basename(source));
    return moveCore(sourceRaw, source, target, 'move');
  },
};

export const renameFileDef: ToolDef = {
  name: 'rename_file',
  description: '重命名文件：newName 只能是不含路径分隔符的新文件名，目标已存在则拒绝（不覆盖）。write 操作。',
  params: [
    { name: 'source', type: 'string', required: true, description: '要重命名的文件路径' },
    { name: 'newName', type: 'string', required: true, description: '新文件名（不能包含路径分隔符）' },
  ],
  policy: 'write',
  riskLevel: 'L2',
  handler: (args: Record<string, unknown>, ctx: ToolContext): ToolHandlerResult => {
    const sourceRaw = String(args.source);
    const source = assertPathAllowed(sourceRaw, ctx.allowedRoots);
    if (!source) return { ok: false, error: 'path-not-allowed' };
    const newName = String(args.newName);
    if (newName.includes(path.sep) || newName.includes('\\') || newName.includes('/')) {
      return { ok: false, error: 'param-invalid: newName 不能包含路径分隔符' };
    }
    const target = path.join(path.dirname(source), newName);
    return moveCore(sourceRaw, source, target, 'rename');
  },
};
