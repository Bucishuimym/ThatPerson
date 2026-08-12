# ThatPerson 出厂技能库（项目级 skills/）

> 本目录为 ThatPerson **出厂自带技能库**，随 npm 包发布。
> 任意目录运行 `thatperson` 时，包内 `skills/` 下的技能都会被扫描到（`src/skill.ts` 默认扫描 `../../skills` 即包根 `skills/`）。

## 目录约定
- 每个技能一个子目录，必须含 `SKILL.md`（frontmatter：`name` / `description` / `trigger_keywords`）。
- **用户级优先**：`~/.thatperson/skills/` 下的同名技能会覆盖出厂技能（`src/skill.ts` 同名去重、用户级优先）。
- 用户可随时增删本目录技能；对已发布 npm 包的用户，出厂技能随包更新。

## 当前出厂技能（种子）
| 技能 | 说明 |
| :--- | :--- |
| code-op | 代码优化 / 重构 / 审查 |
| industry-analysis | 行业分析（现状 / 趋势 / 行情） |
| prompt-op | 提示词优化 / 人设与系统提示词工程 |
| vault-api-bridge | Obsidian 知识库桥接（读取 / 搜索 / 投喂） |
| warehouses-management | 知识库整理（收件箱 / 分类 / 归档） |

> 种子技能源自项目 `.claude/skills/`（开发期技能），可按需增删替换。