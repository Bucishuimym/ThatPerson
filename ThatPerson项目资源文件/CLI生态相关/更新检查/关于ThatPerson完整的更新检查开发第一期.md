## 更新自动检查 参考代码

> 来源：BUCISHUI 第四版提示词原稿「新增更新自动检查功能」节。
> **性质：仅供参考，需按项目实际适配**（用户明确：代码仅供参考）。
> 关联：CLI 全局指令见 `CLI生态相关\指令相关\关于ThatPerson完整的CLI生态开发第一期.md`；界面美化见 `CLI生态相关\CLI美化\`。交付物见优化版提示词第 9 项（说明清单双落点）。

### 核心逻辑

1. **获取当前版本**：从项目根目录 `package.json` 读取 `version` 字段（从第四期开始 version 逐代叠加，当前基线 1.0.0）。
2. **获取最新版本**：向 npm 仓库 `https://registry.npmjs.org/thatperson/latest` 查询最新版本号。
3. **对比版本**：`latest > current` 时在 CLI 启动输出更新提示。
4. **缓存机制**：不每次启动都请求网络，用本地缓存文件记录上次检查时间（12 小时检查一次）。

### 1. 创建 src/utils/update-check.ts

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readFile, writeFile, mkdir } from 'fs/promises';

// 获取当前版本（从 package.json）
function getCurrentVersion(): string {
  const pkgPath = join(__dirname, '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

// 检查是否应该检查更新（12小时缓存）
async function shouldCheckUpdate(): Promise<boolean> {
  const cacheDir = join(homedir(), '.thatperson');
  const cacheFile = join(cacheDir, '.last-update-check');
  
  try {
    const content = await readFile(cacheFile, 'utf-8');
    const lastCheck = parseInt(content, 10);
    const now = Date.now();
    const twelveHours = 12 * 60 * 60 * 1000;
    return (now - lastCheck) > twelveHours;
  } catch {
    // 文件不存在，需要检查
    return true;
  }
}

// 记录本次检查时间
async function recordCheckTime(): Promise<void> {
  const cacheDir = join(homedir(), '.thatperson');
  const cacheFile = join(cacheDir, '.last-update-check');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, String(Date.now()), 'utf-8');
}

// 从 npm 获取最新版本
async function getLatestVersionFromNpm(): Promise<string | null> {
  try {
    const response = await fetch('https://registry.npmjs.org/thatperson/latest', {
      signal: AbortSignal.timeout(3000) // 3秒超时
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.version || null;
  } catch {
    return null; // 网络错误时静默失败
  }
}

// 主函数：检查并输出提示
export async function checkForUpdates(): Promise<void> {
  // 开发模式跳过检查（通过环境变量控制）
  if (process.env.THATPERSON_DEV === 'true') {
    return;
  }

  const current = getCurrentVersion();
  
  // 检查缓存是否过期
  const needCheck = await shouldCheckUpdate();
  if (!needCheck) return;

  // 记录本次检查时间
  await recordCheckTime();

  // 获取最新版本
  const latest = await getLatestVersionFromNpm();
  if (!latest) return;

  // 版本对比
  if (latest !== current) {
    console.log('\x1b[36m%s\x1b[0m', `✨ ThatPerson 新版本 ${latest} 可用！`);
    console.log(`   当前版本: ${current}`);
    console.log(`   升级命令: npm install -g thatperson@latest`);
    console.log('');
  }
}
```

### 2. 在 cli.ts 入口调用

```typescript
#!/usr/bin/env node

import { checkForUpdates } from './utils/update-check';

// ... 其他 import

// 在程序启动时，异步执行检查（不阻塞主程序）
checkForUpdates().catch(() => {}); // 静默失败

// 然后正常执行你的 CLI 命令解析
// program.parse() 或其他逻辑
```

### 3. 参考注意点

- **无新增运行时依赖**：`fetch` 为 Node 18+ 内置，`fs / path / os` 为内置模块——不需要供应链评审。但 `package.json` 若改 `name` 为小写（第 12 项硬门禁），registry URL 需与之一致（示例已用小写 `thatperson`）。
- **本地开发环境暂需绕过 404**（包尚未发布，registry 无此包）：① 运行 `thatperson` 时设 `THATPERSON_DEV=true`；② 或在 `checkForUpdates` 开头加判断：当前项目路径包含 `G:\XXFS\` 时自动跳过。
- 版本号**必须在 `package.json` 中维护**（逐代叠加，基线 1.0.0，发布时递增到 ≥1.1.0）。
- 更新检查对应的内部指令/全局指令需一并加入 CLI 帮助与说明文档。
- 遵循安全红线：不打印 Key、不外发数据；网络请求仅向官方 registry，3 秒超时静默失败。
