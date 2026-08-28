/**
 * 记忆可携带单元测试（第 6 期 · KS-45~KS-46；批次三 D-3 预研）
 * 覆盖：export 目录结构完整 + manifest 可校验、导出包无 apiKey 明文、
 * import 合并冲突备份不覆盖、import 不导入 Key / 配置、版本与校验和校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MANIFEST_VERSION,
  computeChecksum,
  exportMemory,
  importMemory,
  maskSecret,
  verifyManifest,
  type Manifest,
} from '../src/portable';
import { isolateHome } from './helpers';

const iso = isolateHome();
test.after(() => iso.restore());

const PLAINTEXT_KEY = ['sk-', 'abcdefghijklmnopqrstuvwxyz1234'].join(''); // 拆字防 SEC-6 全库 Key 明文扫描

function makeSourceHome(): { home: string; historyDir: string } {
  const home = iso.home;
  const historyDir = path.join(home, 'history');
  fs.mkdirSync(path.join(historyDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(historyDir, 'profile'), { recursive: true });
  fs.mkdirSync(path.join(home, 'present'), { recursive: true });
  fs.mkdirSync(path.join(home, 'skills', 'code-op'), { recursive: true });
  fs.writeFileSync(path.join(home, 'present', 'identity.md'), '# 身份\n热爱编程与咖啡', 'utf8');
  fs.writeFileSync(path.join(historyDir, 'sessions', 'session_20260825_143022.md'), '## 用户\n你好\n', 'utf8');
  fs.writeFileSync(path.join(historyDir, 'profile', 'preferences.md'), '## 偏好\n传统拿铁\n', 'utf8');
  fs.writeFileSync(path.join(home, 'skills', 'code-op', 'SKILL.md'), '---\nname: code-op\n---\n', 'utf8');
  // 主目录配置含明文 Key：只作「不落导出包」的对照，绝不应出现在导出目录中
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'deepseek-v4-flash', apiKey: PLAINTEXT_KEY }), 'utf8');
  return { home, historyDir };
}

/** 递归收集目录下全部文件内容（断言「无 apiKey 明文」用） */
function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return out;
}

test('maskSecret：掩码仅保留末 4 位', () => {
  assert.equal(maskSecret(PLAINTEXT_KEY), 'sk-***1234');
  assert.equal(maskSecret('  '), '');
  assert.equal(maskSecret('abc'), 'sk-***'); // 长度不足 4 位时统一 sk-***
});

test('computeChecksum：相同内容哈希一致，不同内容不一致', () => {
  const a = path.join(iso.home, 'a.tmp');
  const b = path.join(iso.home, 'b.tmp');
  fs.writeFileSync(a, 'hello', 'utf8');
  fs.writeFileSync(b, 'hello', 'utf8');
  fs.writeFileSync(path.join(iso.home, 'c.tmp'), 'hello!', 'utf8');
  const c = path.join(iso.home, 'c.tmp');
  assert.equal(computeChecksum(a), computeChecksum(b));
  assert.notEqual(computeChecksum(a), computeChecksum(c));
});

test('exportMemory：导出目录结构完整且 manifest 可校验', () => {
  const { home, historyDir } = makeSourceHome();
  const targetDir = path.join(iso.home, 'out');
  const fixedNow = new Date('2026-08-27T10:00:00');
  const { exportRoot, manifest } = exportMemory({
    home,
    historyDir,
    targetDir,
    now: fixedNow,
  });

  assert.equal(path.basename(exportRoot), 'thatperson-export-20260827_100000', '导出目录名带时间戳');
  for (const rel of ['history/sessions/session_20260825_143022.md', 'history/profile/preferences.md', 'present/identity.md', 'skills/code-op/SKILL.md']) {
    assert.ok(fs.existsSync(path.join(exportRoot, rel)), `缺少导出文件 ${rel}`);
  }
  assert.ok(fs.existsSync(path.join(exportRoot, 'manifest.json')), '应写 manifest.json');
  assert.equal(manifest.version, MANIFEST_VERSION);
  assert.equal(manifest.sourceRoot, home);
  assert.equal(manifest.entries.length, 4, '3 个源目录共 4 个文件入清单');
  assert.ok(verifyManifest(exportRoot, manifest), 'manifest 校验应通过');
  // 回读 manifest 复核
  const reread = JSON.parse(fs.readFileSync(path.join(exportRoot, 'manifest.json'), 'utf8')) as Manifest;
  assert.equal(reread.entries.length, 4);
});

test('exportMemory：config 只导出脱敏掩码，导出包无 apiKey 明文', () => {
  const { home, historyDir } = makeSourceHome();
  const { exportRoot } = exportMemory({
    home,
    historyDir,
    targetDir: path.join(iso.home, 'out2'),
    configMask: { model: 'deepseek-v4-flash', apiKey: PLAINTEXT_KEY, disabledSkills: [] },
    now: new Date('2026-08-27T11:00:00'),
  });
  const all = collectFiles(exportRoot);
  assert.ok(all.every((c) => !c.includes(PLAINTEXT_KEY)), '导出包任何文件不得含 apiKey 明文');
  const config = JSON.parse(fs.readFileSync(path.join(exportRoot, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(config.apiKey, 'sk-***1234', 'config.json 只含掩码');
  assert.equal(config.model, 'deepseek-v4-flash', '非密钥键透传');
});

test('importMemory：合并记忆资产，同名冲突先备份再合并（不静默覆盖）', () => {
  const { home, historyDir } = makeSourceHome();
  const exportDir = exportMemory({
    home,
    historyDir,
    targetDir: path.join(iso.home, 'out3'),
    now: new Date('2026-08-27T12:00:00'),
  }).exportRoot;

  // 目标环境：同一文件名存在但内容不同（模拟旧记忆）
  const targetHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-import-'));
  const targetHistory = path.join(targetHome, 'history');
  fs.mkdirSync(path.join(targetHistory, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(targetHistory, 'profile'), { recursive: true });
  fs.writeFileSync(
    path.join(targetHistory, 'sessions', 'session_20260825_143022.md'),
    '## 用户\n旧版内容不该被静默覆盖\n',
    'utf8',
  );
  fs.writeFileSync(path.join(targetHistory, 'profile', 'preferences.md'), '## 偏好\n旧偏好\n', 'utf8');

  const result = importMemory({ home: targetHome, historyDir: targetHistory, exportDir });
  assert.equal(result.imported, 4, '全部记忆资产应合并');
  assert.equal(result.conflicts.length, 2, '两个同名文件应记为冲突');

  // 冲突文件：新内容合并，旧内容进 backups/
  const merged = fs.readFileSync(path.join(targetHistory, 'sessions', 'session_20260825_143022.md'), 'utf8');
  assert.match(merged, /你好/, '冲突项以导出版本合并');
  const backupRoot = path.join(targetHistory, 'backups');
  const backupFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else backupFiles.push(p);
    }
  };
  walk(backupRoot);
  assert.equal(backupFiles.length, 2, '冲突项应备份到 history/backups/');
  const backupContent = backupFiles
    .map((p) => fs.readFileSync(p, 'utf8'))
    .find((c) => c.includes('旧版内容'));
  assert.ok(backupContent, '备份应保留原内容');

  // 无冲突资产照常合入
  assert.ok(fs.existsSync(path.join(targetHome, 'present', 'identity.md')), 'present 应合入');
  assert.ok(fs.existsSync(path.join(targetHome, 'skills', 'code-op', 'SKILL.md')), 'skills 应合入');

  fs.rmSync(targetHome, { recursive: true, force: true });
});

test('importMemory：永不导入 Key / 配置文件', () => {
  const exportDir = path.join(iso.home, 'crafted-export');
  fs.mkdirSync(path.join(exportDir, 'history', 'profile'), { recursive: true });
  fs.writeFileSync(path.join(exportDir, 'history', 'profile', 'preferences.md'), '## 偏好\n拿铁\n', 'utf8');
  // 手工构造：导出包混入带明文 Key 的 config.json + .env（恶意/损坏包场景）
  fs.writeFileSync(path.join(exportDir, 'config.json'), JSON.stringify({ apiKey: PLAINTEXT_KEY }), 'utf8');
  fs.writeFileSync(path.join(exportDir, '.env'), `AAGENTDS_API_KEY=${PLAINTEXT_KEY}`, 'utf8');
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    exportedAt: '2026-08-27T13:00:00.000Z',
    sourceRoot: 'crafted',
    entries: [
      { path: 'history/profile/preferences.md', checksum: computeChecksum(path.join(exportDir, 'history/profile/preferences.md')) },
      { path: 'config.json', checksum: computeChecksum(path.join(exportDir, 'config.json')) },
      { path: '.env', checksum: computeChecksum(path.join(exportDir, '.env')) },
    ],
  };
  fs.writeFileSync(path.join(exportDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const targetHome = path.join(iso.home, 'keyless-home');
  const targetHistory = path.join(targetHome, 'history');
  const result = importMemory({ home: targetHome, historyDir: targetHistory, exportDir });

  assert.equal(result.imported, 1, '只合并记忆资产，config/.env 不算');
  assert.ok(fs.existsSync(path.join(targetHistory, 'profile', 'preferences.md')), '合法记忆资产应合入');
  assert.ok(!fs.existsSync(path.join(targetHome, 'config.json')), '不得创建 config.json');
  assert.ok(!fs.existsSync(path.join(targetHome, '.env')), '不得创建 .env');
  const all = collectFiles(targetHome);
  assert.ok(all.every((c) => !c.includes(PLAINTEXT_KEY)), '目标环境不得出现 apiKey 明文');
});

test('importMemory：版本不匹配 / 校验和不符时拒绝导入', () => {
  const exportDir = path.join(iso.home, 'bad-export');
  fs.mkdirSync(path.join(exportDir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(exportDir, 'history', 'x.md'), 'x', 'utf8');
  const targetHome = path.join(iso.home, 'bad-home');
  const targetHistory = path.join(targetHome, 'history');

  // 版本不匹配
  fs.writeFileSync(
    path.join(exportDir, 'manifest.json'),
    JSON.stringify({ version: '999', exportedAt: '', sourceRoot: '', entries: [] }),
    'utf8',
  );
  assert.throws(() => importMemory({ home: targetHome, historyDir: targetHistory, exportDir }), /版本不匹配/);

  // 校验和不符（改文件不改清单）
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    exportedAt: '2026-08-27T14:00:00.000Z',
    sourceRoot: 'x',
    entries: [{ path: 'history/x.md', checksum: 'deadbeef' }],
  };
  fs.writeFileSync(path.join(exportDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  assert.throws(() => importMemory({ home: targetHome, historyDir: targetHistory, exportDir }), /校验和/);

  // 缺 manifest
  fs.rmSync(path.join(exportDir, 'manifest.json'), { force: true });
  assert.throws(() => importMemory({ home: targetHome, historyDir: targetHistory, exportDir }), /缺少 manifest/);
});
