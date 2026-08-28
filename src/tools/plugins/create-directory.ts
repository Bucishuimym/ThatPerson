/**
 * create_directory 插件工具（第 6 期批次一 · 能力底座口径；第 6 期批次二 · KS-34 标注 L2）
 *
 * 递归创建目录（幂等）：目录已存在直接返回成功，不存在则 mkdirSync(recursive)。
 * write 操作，路径须在允许目录内（assertPathAllowed）。
 */
import fs from 'node:fs';
import { assertPathAllowed } from '../guards';
import type { ToolContext, ToolDef, ToolHandlerResult } from '../types';

export const createDirectoryDef: ToolDef = {
  name: 'create_directory',
  description: '递归创建目录（幂等）：已存在则直接返回成功，不存在则创建。write 操作，路径必须在允许目录内。',
  params: [{ name: 'path', type: 'string', required: true, description: '要创建的目录路径' }],
  policy: 'write',
  riskLevel: 'L2',
  handler: (args: Record<string, unknown>, ctx: ToolContext): ToolHandlerResult => {
    const raw = String(args.path);
    const safe = assertPathAllowed(raw, ctx.allowedRoots);
    if (!safe) return { ok: false, error: 'path-not-allowed' };
    try {
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(safe);
      } catch {
        stat = null;
      }
      if (stat) {
        if (stat.isDirectory()) return { ok: true, content: '目录已存在，幂等返回' };
        return { ok: false, error: 'path-exists-not-directory' };
      }
      fs.mkdirSync(safe, { recursive: true });
    } catch (err) {
      return { ok: false, error: `mkdir-failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, content: `已创建目录 ${raw}` };
  },
};
