/**
 * e2e · 记忆可带走闭环（第 6 期批次三 · KS-45~KS-46；--mock 全自动）
 *
 * 运行：node --test dist-test/tests/e2e/*.test.js
 * 闭环：exportMemory（源 home）→ 隔离目标 home importMemory → memory search 命中；
 *       导出包全文 grep 无 apiKey 明文（Key 拆字构造，防 SEC-6 全库扫描误报）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { memorySearchText } from '../../src/cli';
import { exportMemory, importMemory } from '../../src/portable';
import { isolateHome } from '../helpers';

const iso = isolateHome();
test.after(() => iso.restore());

const PLAINTEXT_KEY = ['sk-', 'e2eportableabcdefghijklmnopqrstuvwxyz'].join(''); // 拆字防 SEC-6 全库扫描误报

/** 递归收集目录下全部文件文本（断言「无明文 Key」用） */
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

test('记忆可带走闭环：export → 新 home import → memory search 命中，导出包无 Key 明文', () => {
  // 源 home：记忆资产 + 含明文 Key 的 config.json（只作「不落包」对照）
  const sourceHome = path.join(iso.home, 'source');
  const historyDir = path.join(sourceHome, 'history');
  fs.mkdirSync(path.join(historyDir, 'profile'), { recursive: true });
  fs.mkdirSync(path.join(historyDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(sourceHome, 'present'), { recursive: true });
  fs.mkdirSync(path.join(sourceHome, 'skills', 'code-op'), { recursive: true });
  fs.writeFileSync(path.join(historyDir, 'profile', 'preferences.md'), '## 偏好\n传统拿铁，周末爬山\n', 'utf8');
  fs.writeFileSync(path.join(historyDir, 'sessions', 'session_20260827_150000.md'), '## 用户\n你好\n', 'utf8');
  fs.writeFileSync(path.join(sourceHome, 'present', 'identity.md'), '# 身份\n热爱编程与咖啡\n', 'utf8');
  fs.writeFileSync(path.join(sourceHome, 'skills', 'code-op', 'SKILL.md'), '---\nname: code-op\n---\n', 'utf8');
  fs.writeFileSync(path.join(sourceHome, 'config.json'), JSON.stringify({ model: 'm', apiKey: PLAINTEXT_KEY }), 'utf8');

  // export：目标父目录 + config 只出脱敏掩码
  const targetDir = path.join(iso.home, 'out');
  const exported = exportMemory({
    home: sourceHome,
    historyDir,
    targetDir,
    presentDir: path.join(sourceHome, 'present'),
    skillsDir: path.join(sourceHome, 'skills'),
    configMask: { model: 'm', apiKey: PLAINTEXT_KEY },
  });
  assert.ok(fs.existsSync(path.join(exported.exportRoot, 'manifest.json')), '应生成 manifest.json');
  for (const content of collectFiles(exported.exportRoot)) {
    assert.ok(!content.includes(PLAINTEXT_KEY), '导出包不得含 apiKey 明文');
  }

  // 新 home import：合并记忆资产
  const targetHome = path.join(iso.home, 'target');
  const targetHistory = path.join(targetHome, 'history');
  const result = importMemory({ home: targetHome, historyDir: targetHistory, exportDir: exported.exportRoot });
  assert.ok(result.imported >= 3, `应导入记忆资产，实际 ${result.imported}`);
  assert.ok(fs.existsSync(path.join(targetHistory, 'profile', 'preferences.md')), '偏好记忆应合入');

  // memory search 命中
  const hits = memorySearchText(targetHistory, '拿铁');
  assert.ok(hits.includes('拿铁'), `memory search 应命中，实际：${hits}`);

  // 目标 home 全文无明文 Key
  const all = collectFiles(targetHome);
  assert.ok(all.every((c) => !c.includes(PLAINTEXT_KEY)), '目标 home 不得出现 Key 明文');
});
