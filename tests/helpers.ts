/**
 * 测试隔离工具（IS-1~IS-3 支撑）
 *
 * 目标：所有测试与主程序完全隔离，不相互污染。
 * - isolateHome()：把 THATPERSON_HOME 重定向到临时目录；restore() 恢复环境变量并清理。
 * - snapshotTree()：递归快照目录树（相对路径 -> 大小 + mtime），用于断言真实目录未被修改。
 * - assertTreeUnchanged()：对比快照，抛出首个差异。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Isolation {
  /** 隔离用临时 home 目录（THATPERSON_HOME 的临时值） */
  home: string;
  /** 恢复环境变量并删除临时目录 */
  restore(): void;
}

function restoreEnv(prev: string | undefined, name: string): void {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

/** 创建临时目录并把 THATPERSON_HOME 指向它；同时清空 THATPERSON_MEMORY_DIR 避免穿越隔离 */
export function isolateHome(): Isolation {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-iso-'));
  const savedHome = process.env.THATPERSON_HOME;
  const savedMemory = process.env.THATPERSON_MEMORY_DIR;
  process.env.THATPERSON_HOME = home;
  delete process.env.THATPERSON_MEMORY_DIR;
  return {
    home,
    restore(): void {
      restoreEnv(savedHome, 'THATPERSON_HOME');
      restoreEnv(savedMemory, 'THATPERSON_MEMORY_DIR');
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 递归快照目录树：相对路径 -> { size, mtimeMs } */
export function snapshotTree(root: string): Record<string, { size: number; mtimeMs: number }> {
  const out: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else {
        const st = fs.statSync(p);
        out[path.relative(root, p)] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
      }
    }
  };
  walk(root);
  return out;
}

/** 断言目录树未被修改（文件集合 / 大小 / 修改时间一致；before 为 null 表示目录原本不存在） */
export function assertTreeUnchanged(
  before: Record<string, { size: number; mtimeMs: number }> | null,
  root: string,
): void {
  if (before === null) {
    if (fs.existsSync(root)) throw new Error(`目录不应被创建：${root}`);
    return;
  }
  const after = snapshotTree(root);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    if (b === undefined) throw new Error(`出现新增文件：${key}`);
    if (a === undefined) throw new Error(`文件丢失：${key}`);
    if (b.size !== a.size || b.mtimeMs !== a.mtimeMs) {
      throw new Error(`文件被修改：${key}`);
    }
  }
}
