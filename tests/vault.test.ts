/**
 * PARA 初始仓库测试（第 7 期批次二 · WB-5；KS-7.26 / T7）
 *
 * 契约：ensureParaVault() 首启在 vaultRoot() 下生成 PARA 五目录 + 顶层 README.md（含 PARA 结构说明字样）
 * + 每目录 1 个占位说明 .md；重复调用幂等（created=false，不重建不覆盖，mtime/内容不变）；
 * THATPERSON_VAULT_ROOT 重定向生效（缺省 <THATPERSON_HOME>/vault）。
 *
 * D-4 红侧：src/vault.ts 的 ensureParaVault 为不落盘桩（只解析根路径），本文件红在断言层。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PARA_DIRS, ensureParaVault, vaultRoot } from '../src/vault';
import { assertTreeUnchanged, isolateHome, snapshotTree } from './helpers';

const iso = isolateHome();
const savedVaultRoot = process.env.THATPERSON_VAULT_ROOT;
delete process.env.THATPERSON_VAULT_ROOT;
test.after(() => {
  if (savedVaultRoot === undefined) delete process.env.THATPERSON_VAULT_ROOT;
  else process.env.THATPERSON_VAULT_ROOT = savedVaultRoot;
  iso.restore();
});

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('WB-5 ensureParaVault：首启生成五目录 + 顶层 README（PARA 说明）+ 每目录占位 .md', () => {
  const result = ensureParaVault();
  const root = vaultRoot();
  assert.equal(path.resolve(result.root), path.resolve(root), '返回 root 应与 vaultRoot() 一致');
  assert.equal(result.created, true, '首启 created 应为 true');
  assert.equal(
    path.resolve(root),
    path.resolve(path.join(iso.home, 'vault')),
    '缺省 vault 应落在 <THATPERSON_HOME>/vault',
  );
  for (const dir of PARA_DIRS) {
    assert.ok(fs.existsSync(path.join(root, dir)), `应生成目录 ${dir}`);
  }
  const readmePath = path.join(root, 'README.md');
  assert.ok(fs.existsSync(readmePath), '顶层应生成 README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  assert.ok(readme.includes('PARA'), 'README 应含 PARA 结构说明字样');
  for (const dir of PARA_DIRS) {
    assert.ok(readme.includes(dir), `README 应说明 ${dir} 用途`);
    const entries = fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.md'));
    assert.equal(entries.length, 1, `每个 PARA 目录应有 1 个占位 .md：${dir}`);
    const placeholder = fs.readFileSync(path.join(root, dir, entries[0]), 'utf8');
    assert.ok(placeholder.trim().length > 0, `占位文件应有说明内容：${dir}`);
  }
});

test('WB-5 ensureParaVault：重复调用幂等（created=false，不重建不覆盖）', () => {
  const redirect = tmpDir('thatperson-vault-idem-');
  process.env.THATPERSON_VAULT_ROOT = redirect;
  try {
    const first = ensureParaVault();
    assert.equal(first.created, true, '前置：独立 vault 首次调用应创建');
    // 用户改动 README 后再调用：不得覆盖重建
    const readmePath = path.join(redirect, 'README.md');
    const custom = '# 自定义 README（用户改过，不应被重建覆盖）';
    fs.writeFileSync(readmePath, custom, 'utf8');
    // O-1 裁决（批次二）：快照移到用户改写之后——原位置在改写前，会把测试自身改动的 mtime/size
    // 差误判为实现重写；移位后本断言恢复原意（ensureParaVault 不得改动任何既有文件）
    const before = snapshotTree(redirect);
    const second = ensureParaVault();
    assert.equal(second.created, false, '二次调用 created 应为 false');
    assert.equal(fs.readFileSync(readmePath, 'utf8'), custom, '已有 README 不应被覆盖重建');
    const after = snapshotTree(redirect);
    for (const [rel, meta] of Object.entries(before)) {
      const now = after[rel];
      assert.ok(now, `文件不应丢失：${rel}`);
      assert.equal(now.mtimeMs, meta.mtimeMs, `文件 mtime 不应变化（不重写）：${rel}`);
      assert.equal(now.size, meta.size, `文件内容不应变化：${rel}`);
    }
  } finally {
    delete process.env.THATPERSON_VAULT_ROOT;
    fs.rmSync(redirect, { recursive: true, force: true });
  }
});

test('WB-5 THATPERSON_VAULT_ROOT 重定向生效', () => {
  const redirect = tmpDir('thatperson-vault-redir-');
  process.env.THATPERSON_VAULT_ROOT = redirect;
  try {
    // O-1 裁决（批次二）：原 line96 断言「缺省 vault 不存在」与 t1 矛盾（t1 同文件先跑且已创建缺省 vault），
    // 改为顺序无关的「本次调用不得改动缺省 vault」断言，语义不变（重定向时不写缺省路径）。
    const defaultVault = path.join(iso.home, 'vault');
    const defaultSnapshot = fs.existsSync(defaultVault) ? snapshotTree(defaultVault) : null;
    assert.equal(path.resolve(vaultRoot()), path.resolve(redirect), 'vaultRoot() 应优先环境变量');
    const result = ensureParaVault();
    assert.equal(path.resolve(result.root), path.resolve(redirect), 'ensureParaVault 应落在重定向根');
    assert.equal(result.created, true, '重定向根首次生成 created 应为 true');
    for (const dir of PARA_DIRS) {
      assert.ok(fs.existsSync(path.join(redirect, dir)), `重定向根下应生成 ${dir}`);
    }
    assert.ok(fs.existsSync(path.join(redirect, 'README.md')), '重定向根下应生成 README.md');
    if (defaultSnapshot === null) {
      assert.ok(!fs.existsSync(defaultVault), '重定向生效时不应写缺省 vault 路径');
    } else {
      assertTreeUnchanged(defaultSnapshot, defaultVault); // 缺省 vault 已存在（t1 所建）：本次调用不得改动
    }
  } finally {
    delete process.env.THATPERSON_VAULT_ROOT;
    fs.rmSync(redirect, { recursive: true, force: true });
  }
});
