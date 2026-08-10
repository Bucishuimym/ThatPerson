/**
 * 隔离回归测试（IS-1 ~ IS-3）
 *
 * 目标：证明「测试与主程序隔离、不相互污染」这一约束持续有效。
 * - IS-1 隔离生效：THATPERSON_HOME 被重定向到临时目录；
 * - IS-2 主程序完整数据链路在隔离 HOME 下运行后，真实 ~/.thatperson 零变化；
 * - IS-3 restore() 正确恢复环境变量并清理临时目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureConfigDir, thatPersonHome } from '../src/config';
import { loadPresent } from '../src/present';
import { createMemoryStore } from '../src/memory/store';
import { assertTreeUnchanged, isolateHome, snapshotTree } from './helpers';

const iso = isolateHome();
test.after(() => iso.restore());

test('IS-1 隔离生效：THATPERSON_HOME 指向临时目录，不得指向真实 ~/.thatperson', () => {
  const home = thatPersonHome();
  assert.ok(home.startsWith(os.tmpdir()), `应指向临时目录，实际：${home}`);
  assert.ok(home.includes('thatperson-iso-'), '应使用隔离前缀目录');
  assert.notEqual(home, path.join(os.homedir(), '.thatperson'), '不得指向真实全局目录');
});

test('IS-2 主程序完整数据链路在隔离 HOME 下运行，真实 ~/.thatperson 零变化', () => {
  const realHome = path.join(os.homedir(), '.thatperson');
  const before = fs.existsSync(realHome) ? snapshotTree(realHome) : null;

  // 完整跑一遍主程序数据链路（全部落在临时 HOME）：
  ensureConfigDir(); // config.json + 全局目录结构
  loadPresent(); // Present 读取（项目 present 只读）
  const store = createMemoryStore(iso.home);
  store.ensureStructure(); // history/ 结构
  store.appendArchive('profile', {
    type: '偏好',
    dialog: '隔离验证对话',
    insight: '隔离验证：不应写入真实目录',
    confidence: '高',
    tags: ['#隔离'],
  });
  store.appendSessionLog({
    date: '2026-08-10',
    topics: ['隔离'],
    mood: '平静',
    newMemories: [],
    followUps: [],
  });

  assertTreeUnchanged(before, realHome);
});

test('IS-3 restore 恢复环境变量并清理临时目录', () => {
  const savedHome = process.env.THATPERSON_HOME;
  const sub = isolateHome();
  const tmp = sub.home;
  assert.equal(process.env.THATPERSON_HOME, tmp);
  sub.restore();
  assert.equal(process.env.THATPERSON_HOME, savedHome, 'THATPERSON_HOME 应恢复原值');
  assert.ok(!fs.existsSync(tmp), '临时目录应被清理');
});
