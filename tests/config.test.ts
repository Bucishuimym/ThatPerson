/**
 * 记忆目录定位测试（第 3 期补充：THATPERSON_MEMORY_DIR > 项目模式 > ~/.thatperson/history）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isProjectMode, memoryRoot, resolveHistoryDir } from '../src/config';

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-cfg-'));
}

test('isProjectMode：cwd 为本项目（package.json name=ThatPerson）时为 true', () => {
  const root = makeTmpRoot();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ThatPerson' }), 'utf8');
  assert.equal(isProjectMode(root), true);
  assert.equal(isProjectMode(makeTmpRoot()), false, '空目录不应判定为项目模式');
});

test('isProjectMode：存在本项目源码特征也判定为项目模式', () => {
  const root = makeTmpRoot();
  fs.mkdirSync(path.join(root, 'src', 'parser'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'parser', 'archive.ts'), '// probe', 'utf8');
  assert.equal(isProjectMode(root), true);
});

test('memoryRoot：THATPERSON_MEMORY_DIR 显式指定时取其父目录', () => {
  const root = makeTmpRoot();
  const hist = path.join(root, 'my', 'history');
  process.env.THATPERSON_MEMORY_DIR = hist;
  try {
    assert.equal(memoryRoot(root), path.join(root, 'my'));
    assert.equal(resolveHistoryDir(root), hist);
  } finally {
    delete process.env.THATPERSON_MEMORY_DIR;
  }
});

test('memoryRoot：项目模式用 cwd，全局模式用 THATPERSON_HOME', () => {
  const proj = makeTmpRoot();
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'ThatPerson' }), 'utf8');
  const home = makeTmpRoot();
  process.env.THATPERSON_HOME = home;
  try {
    assert.equal(memoryRoot(proj), proj, '项目模式记忆根应为项目目录');
    const elsewhere = makeTmpRoot();
    assert.equal(memoryRoot(elsewhere), home, '非项目目录应回退到全局数据目录');
    assert.equal(resolveHistoryDir(elsewhere), path.join(home, 'history'));
  } finally {
    delete process.env.THATPERSON_HOME;
  }
});