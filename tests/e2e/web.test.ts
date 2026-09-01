/**
 * e2e · web 闭环（第 7 期批次二 · e2e-3；KS-7.26 / 验收判据 7）
 *
 * 运行：npm.cmd test（编译 dist-test）后 node --test dist-test/tests/e2e/*.test.js
 * 闭环（--mock 语义，全程零网络零 Key）：隔离 THATPERSON_HOME 进程内起 web（startWebServer，随机端口）
 *   → GET / 四面板 → PARA 五目录已生成（首启）→ config 层 allowDir 授权临时目录（open 语义）
 *   → /api/vaults 含该目录 → /api/tree 可浏览 → 关键响应无 sk- 形态 → 测后 close() 零句柄泄漏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWebServer } from '../../src/web/server';
import { PARA_DIRS, ensureParaVault } from '../../src/vault';
import { allowDir } from '../../src/config';
import { isolateHome } from '../helpers';
import { closeWebServer, createWebClient } from '../mocks';

const iso = isolateHome();
const savedVaultRoot = process.env.THATPERSON_VAULT_ROOT;
delete process.env.THATPERSON_VAULT_ROOT;
test.after(() => {
  if (savedVaultRoot === undefined) delete process.env.THATPERSON_VAULT_ROOT;
  else process.env.THATPERSON_VAULT_ROOT = savedVaultRoot;
  iso.restore();
});

test('e2e-3 web 闭环：起服务 → 四面板 → PARA 生成 → open 授权 → 文件树可读（零网络零 Key）', async () => {
  const granted = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-e2e-web-open-'));
  fs.writeFileSync(path.join(granted, 'note.md'), '# 授权目录便签\nopen 闭环内容', 'utf8');
  try {
    // 首启：任何模式首启自动建 PARA（进程内以 ensureParaVault 承载 main() 接线语义）
    const vault = ensureParaVault().root;
    // 起服务（随机端口 + --mock 语义：零网络零 Key，测试环境不弹浏览器）
    const handle = await startWebServer({ open: false, isMock: true });
    try {
      const api = createWebClient(`http://127.0.0.1:${handle.port}`);
      // 四面板齐全
      const home = await api.raw('/');
      assert.equal(home.status, 200, 'GET / 应 200');
      const html = await home.text();
      for (const panel of ['file-tree', 'editor', 'chat', 'activity']) {
        assert.ok(html.includes(`data-panel="${panel}"`), `四面板应含 data-panel="${panel}"`);
      }
      // PARA 五目录已生成
      for (const dir of PARA_DIRS) {
        assert.ok(fs.existsSync(path.join(vault, dir)), `PARA 五目录应已生成：${dir}`);
      }
      // open 授权（复用 allow-dir 持久化契约）
      const grant = allowDir(granted);
      assert.equal(grant.ok, true, `open 授权应成功，实际：${grant.ok ? '' : grant.error}`);
      // /api/vaults 含授权目录 → /api/tree 可浏览
      const vaults = await api.json<{ roots?: string[] } | string[]>('/api/vaults');
      assert.equal(vaults.status, 200);
      const roots = Array.isArray(vaults.body) ? (vaults.body as string[]) : ((vaults.body as { roots?: string[] })?.roots ?? []);
      assert.ok(
        roots.some((r) => path.resolve(r).toLowerCase() === path.resolve(granted).toLowerCase()),
        `/api/vaults 应含授权目录，实际：${JSON.stringify(roots)}`,
      );
      const tree = await api.json(`/api/tree?root=${encodeURIComponent(granted)}`);
      assert.equal(tree.status, 200, `授权目录树应可浏览，实际：${tree.status}`);
      assert.ok(tree.text.includes('note.md'), '文件树应能看到授权目录内文件');
      // 全程零 Key：关键响应无 sk- 形态
      for (const t of ['/', '/api/vaults', `/api/tree?root=${encodeURIComponent(granted)}`]) {
        const res = await api.raw(t);
        const text = await res.text();
        assert.ok(!text.includes('sk-'), `${t} 响应无 sk- 形态`);
      }
    } finally {
      await closeWebServer(handle); // 测后 close()，防句柄泄漏
    }
  } finally {
    fs.rmSync(granted, { recursive: true, force: true });
  }
});
