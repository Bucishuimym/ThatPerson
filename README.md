# ThatPerson

无限接近人的个人 AI 伴侣：**API = 大脑 / skill = 手 / Markdown = 记忆**。对话式 CLI，带长期记忆归档、技能系统与能力自省人格（Present）。

## 安装

```powershell
npm install -g @nineteenfolk/thatperson
```

## 环境要求

- Node.js ≥ 18（**声明值**；注意：当前 UI 依赖链为 ESM-only，实际开箱即用最低为 Node ≥ 22.13 / 23.5+，开发验证环境为 Node 24）。
- 需要 DeepSeek API Key：写入项目根 `.env` 的 `AAGENTDS_API_KEY`（或配置为环境变量）。CLI 不硬编码、不打印 Key。

## 快速开始

```powershell
thatperson                  # 进入持续对话模式
thatperson --mock           # 离线演示（不调用 API、不发网络）
thatperson status           # 状态卡片（版本/模型/记忆/技能/Token 预算）
thatperson skills list      # 列出已安装技能
thatperson memory search <关键词>
thatperson config get model
```

对话内内部指令：`/help` `/history` `/clear` `/reset` `/save` `/exit` `/update`。

## 记忆与配置

- 全局目录：`~/.thatperson/`（可通过 `THATPERSON_HOME` 重定向；`THATPERSON_MEMORY_DIR` 可指定记忆目录）。
- 项目模式：在项目根运行并存在 `present/` 时，加载项目人格覆盖；记忆落 `<cwd>/history/`。
- 出厂技能库随包发布（`skills/`），用户级 `~/.thatperson/skills/` 可扩展。

## 发布内容（files 白名单）

仅发布运行时必需目录：`dist/`（编译产物）与 `skills/`（出厂技能库）。资源文件、反馈、项目报告与 API Key 均不打包、不提交。

## 版本规范（Semver）

每次发布遵循语义化版本，使用 `npm version` 自动升级并打 tag：

| 命令 | 场景 | 示例 |
| :--- | :--- | :--- |
| `npm version patch` | 修复 bug | 1.0.0 → 1.0.1 |
| `npm version minor` | 新增功能 | 1.0.0 → 1.1.0 |
| `npm version major` | 破坏性更新 | 1.0.0 → 2.0.0 |

发布前 `prepublishOnly` 会自动执行 `npm run build && npm test`，确保产物最新且测试全绿。
