# ThatPerson

> **本地优先 · 记忆永远在你这。** 所有记忆落成 Markdown 存在你自己的磁盘上——随时可读、可改、可带走，不锁进任何云端黑盒。

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![npm](https://img.shields.io/npm/v/@nineteenfolk/thatperson)
![npm downloads](https://img.shields.io/npm/dm/@nineteenfolk/thatperson)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)

个人 AI 管家：对话式 CLI，带长期记忆归档、技能系统与能力自省人格（Present）。

## 安装

```powershell
npm install -g @nineteenfolk/thatperson
```

## 环境要求

- Node.js ≥ 22.13（当前 UI 依赖链为 ESM-only，require(esm) 需 Node ≥ 22.12 默认启用；inquirer@14 要求 ≥ 22.13；开发验证环境为 Node 24）。
- 需要 DeepSeek API Key：首次运行执行 `thatperson setup` 向导完成配置，或用 `thatperson config set apiKey <Key>`，或设置环境变量 `AAGENTDS_API_KEY`。CLI 不硬编码、不打印 Key（掩码存储）。

## 快速开始

```powershell
thatperson setup            # 首次配置向导（API Key / 模型）
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
- 随身目录：存在 `<cwd>/.thatperson/` 时，加载随身目录人格覆盖，记忆落 `<cwd>/.thatperson/history/`；否则落主目录 `~/.thatperson/history/`。
- 首次配置：`thatperson setup` 写回 `config.json`（含 `apiKey` 掩码存储与 `configured` 标记）；旧配置文件读取时给缺省值、不静默改写。
- 出厂技能库随包发布（`skills/`），用户级 `~/.thatperson/skills/` 可扩展。
- 人格加载优先级：**主目录 `~/.thatperson/present/` > 随身目录 `<cwd>/.thatperson/present/` > 出厂级（包内 `present/`）**；缺失文件自动回退下一级，同名不覆盖。

## 发布内容（files 白名单）

发布运行时必需目录：`dist/`（编译产物）、`present/`（出厂人格）与`skills/`（出厂技能库）。资源文件、反馈、项目报告与 API Key 均不打包、不提交。

出厂人格兜底：加载优先级为主目录 `~/.thatperson/present/` > 随身目录 `<cwd>/.thatperson/present/` > 出厂级（包内 `present/`）；缺失的文件名自动回退出厂补齐，同名不覆盖。
## 版本规范（Semver）

每次发布遵循语义化版本，使用 `npm version` 自动升级并打 tag：

| 命令 | 场景 | 示例 |
| :--- | :--- | :--- |
| `npm version patch` | 修复 bug | 1.0.0 → 1.0.1 |
| `npm version minor` | 新增功能 | 1.0.0 → 1.1.0 |
| `npm version major` | 破坏性更新 | 1.0.0 → 2.0.0 |

发布前 `prepublishOnly` 会自动执行 `npm run build && npm test`，确保产物最新且测试全绿。
