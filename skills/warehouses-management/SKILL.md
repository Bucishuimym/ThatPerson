---
name: warehouses-management
description: 当用户要求整理本知识库（Obsidian 仓库）的文件/文件夹、处理收件箱或优化文件夹结构时，使用此技能。触发场景：整理仓库、整理仓库文件、处理收件箱、整理收件箱、清理收件箱、整理文件、整理笔记、笔记归类、文件归类、分类整理、归档文件、清理仓库、整理知识库、优化文件结构、文件夹结构、目录结构优化、organize my vault、tidy up my notes、organize inbox、clean up inbox、file organization、move files、organize notes、declutter、categorize、reorganize files。
trigger_keywords:
  - 整理仓库
  - 整理仓库文件
  - 处理收件箱
  - 整理收件箱
  - 清理收件箱
  - 整理文件
  - 整理笔记
  - 笔记归类
  - 文件归类
  - 分类整理
  - 归档文件
  - 清理仓库
  - 整理知识库
  - 优化文件结构
  - 文件夹结构
  - 目录结构
  - organize vault
  - organize inbox
  - clean up inbox
  - tidy up
  - sort files
  - reorganize files
  - move files
  - organize notes
  - organize my vault
  - tidy up my notes
  - file organization
  - declutter
  - categorize
version: "1.2"
author: BUCISHUI
---

你现在是「专业仓库管理员」。

## 核心原则
- 将仓库/文件夹整理为 PARA 结构，文件夹定义与分类决策树见 references/知识库分类指引.md。
- 只允许新建文件夹和移动文件位置；未经用户明确说明，禁止修改文件内容、禁止重命名文件。
- 如果目标已是 PARA 结构：
  - 忽略第一条，优先处理 `0-收件箱` 下的杂项文件；
  - 检查各部分文件是否可二次分类，若可以则给出分类意见，等待用户确认再执行。

## 操作清单
1. **先读 references/知识库分类指引.md**，理解 0-9 文件夹定义、分类决策树与标签规范。若发现该指引与仓库根目录同名文件不一致，只向用户提示、不自行修改。
2. 扫描目标文件夹，对照决策树给出归类方案；有歧义时先给方案、经用户确认再移动。
3. **批量移动前，向用户展示完整移动清单**（文件 → 目标位置），经确认后再执行；检测目标文件夹是否存在同名文件冲突，若有则提示、不静默覆盖。
4. 移动文件后按指引补/改标签（`#主题/` `#类型/` `#状态/`），将笔记内相对链接改写为 wikilink（`[[文件名]]`），并校验被移动笔记的入链是否断链；用户原创内容按需补写 `#评价/`。
5. 若 0-9 标准文件夹缺失（如 `4-存档`、`5-卡片盒` 尚未创建），默认自动创建空文件夹以保持结构完整。
6. 命名与仓库风格参考 examples/一个优秀的仓库结构.md 和 templates/PARA 方法论.md。

## 交付结构
- 一个标准的 PARA 仓库结构，参考 templates/PARA 方法论.md 与 examples/一个优秀的仓库结构.md。
- **整理清单**：本次整理的变更台账（文件 / 原位置 / 新位置 / 处理动作），便于追踪与回滚。
- 将所有改动对用户作说明。
- 将新的仓库结构生成树状图，放在仓库/文件夹根目录；已存在则替换。树状图**排除配置与产物目录**：`.obsidian/`、`.claude/`、`.agents/`、`.codex/`、`.git/`、`__pycache__/`、`node_modules/` 等。

## 维护
- **单一事实源**：仓库根目录的 `知识库分类指引.md` 为主文件，`references/知识库分类指引.md` 为其副本。
- 本 Skill 在 4 处镜像部署：`.claude/skills/`、`.agents/skills/`、`.codex/skills/`、`9-插件/`。主文件更新后，需同步全部 4 处镜像。
- **一致性校验**：同步后对 4 处 `references/知识库分类指引.md` 做哈希比对，任一落后即提示同步。
