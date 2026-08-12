# 项目状态报告

> 项目名称：ThatPerson
> 报告期次：第 4 期
> 报告日期：2026-08-12
> 编制人：Scribe Agent（Agent Team 文档组，S-1）
> 审批人：BUCISHUI
> 验收结果：Orchestrator 已验证；QA Agent（Q-1）独立复核 **PASS**（111/111 全绿）

## 📌 项目总体概况

| 项目属性 | 内容 |
| :--- | :--- |
| 项目目标 | 按第四版提示词完成第 4 期迭代：P0 发布阻塞修复（--version）→ 归档极性修复 → 元认知行为化（肢觉/指令-执行-返回）→ CLI 生态（内部/全局指令）→ 更新检查 → CLI 界面（ui.ts）→ 初始化优化 → 发布前置（npm pack）→ 安全专项（供应链/模糊测试）→ 反馈闭环 |
| 项目范围 | CLI 全局参数/内部指令/全局子命令、Skill 自动触发修复、能力自省三层分离、更新检查、UI 表现层、config 唯一模型来源、LLM 语义归档（默认关闭）、发布前置、安全测试（SEC-6 更新 + FZ-1~5） |
| 当前阶段 | 开发（已进入发布验收） |
| 总体进度 | 计划 100% vs 实际 100%（14/14 验收通过，`npm.cmd test` 111/111 通过） |
| 项目健康度 | 🟢正常（无阻塞；npm publish 待 BUCISHUI 执行） |

## 🏁 里程碑与关键交付物

| 里程碑名称 | 计划日期 | 实际日期 | 状态 |
| :--- | :--- | :--- | :--- |
| R-1 Key Specs 提炼（第4期-KeySpecs-20260811） | 2026-08-11 | 2026-08-11 | ✅ 已完成 |
| P0：--version / 全局参数解析修复 | 2026-08-12 | 2026-08-12 | ✅ 已完成 |
| 归档极性修复（BC-7/8/9） | 2026-08-12 | 2026-08-12 | ✅ 已完成 |
| 元认知行为化（肢觉/指令-执行-返回/能力自省） | 2026-08-12 | 2026-08-12 | ✅ 已完成 |
| CLI 生态（内部指令 + 全局指令） | 2026-08-12 | 2026-08-12 | ✅ 已完成 |
| 更新检查（update-check.ts） | 2026-08-12 | 2026-08-12 | ✅ 已完成 |
| CLI 界面（ui.ts 封装） | 2026-08-12 | 2026-08-12 | ✅ 已完成 |
| 初始化优化（config.model 唯一来源 + api-key 引导） | 2026-08-12 | 2026-08-12 | ✅ 已完成 |
| 发布前置（name/version/bin/files 核对 + npm pack 49 文件） | 2026-08-12 | 2026-08-12 | ✅ 已完成（publish 待 BUCISHUI） |
| 安全专项（SEC-6 更新 + FZ-1~5 + 操作指南） | 2026-08-12 | 2026-08-12 | ✅ 已完成 |
| 反馈闭环（两份第三期反馈移入 Done） | 2026-08-12 | 2026-08-12 | ✅ 已完成 |
| 三件套 + CLI 双文档 + 架构同步 | 2026-08-12 | 2026-08-12 | ✅ 已完成 |

## 📊 进度详情

| 任务 | 负责人 | 计划工时 | 实际工时 | 状态 | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Key Specs 提炼 | R-1（研究） | 0.5 | 0.5 | ✅ | 资源文件第4期-KeySpecs-20260811.md |
| P0 --version / 参数解析 | D-3（系统工程组） | 0.5 | 0.5 | ✅ | src/cli.ts parseArgs |
| 归档极性（BC-7/8/9） | D-1（智能核心组） | 0.5 | 0.5 | ✅ | src/parser/archive.ts 否定前置/疑问过滤/不确定降级 |
| 元认知行为化 | D-1（智能核心组）+ D-3 | 1 | 1 | ✅ | /check directory、capabilities.md、<技能清单> 摘要层 |
| CLI 生态 | D-3（系统工程组） | 1 | 1 | ✅ | 内部 7 指令 + 全局 8 指令 |
| 更新检查 | D-3（系统工程组） | 0.5 | 0.5 | ✅ | src/utils/update-check.ts |
| CLI 界面 | D-3（系统工程组） | 0.5 | 0.5 | ✅ | src/utils/ui.ts + status 真实数据 |
| 初始化优化 | D-3（系统工程组） | 0.5 | 0.5 | ✅ | config.ts 模型唯一来源 + apiKeyGuidance |
| 发布前置 | D-3（系统工程组） | 0.5 | 0.5 | ✅ | npm pack --dry-run 49 文件（已亲验） |
| 安全专项 | D-4（质量保障组） | 1 | 1 | ✅ | SEC-6 口径 + fuzz 17 变体 + 操作指南 |
| LLM 语义归档 | D-1（智能核心组） | 0.5 | 0.5 | ✅ | src/parser/llm-archive.ts（默认关闭） |
| 反馈闭环归档 | S-1（记录） | 0.3 | 0.3 | ✅ | Done\ 两份反馈附处理状态 |
| 三件套 + 双文档 + 架构同步 | S-1（记录） | 1 | 1 | ✅ | 项目报告\第四期\ + 资源文件双落点 |

## ⚠️ 风险与问题

| 风险描述 | 影响 | 应对措施 | 状态 |
| :--- | :--- | :--- | :--- |
| Windows 控制台管道中文乱码 | 自动化管道输入乱码 | `--input-file` 已覆盖文件场景（UTF-8 剥 BOM）；管道另行评估 | 🔄 处理中（P4 延续） |
| 技能关键词精确匹配敏感 | 「优化一下提示词」等变体未触发 prompt-op | description 前 12 字兜底部分命中；建议扩展 trigger_keywords 变体 | 🔄 处理中（低危） |
| npm publish 尚未执行 | 全局安装仍走手动 shim | 已备好 npm pack 49 文件 + unlink 清单，待 BUCISHUI 确认 1.1.0 后执行 | ⏳ 待 BUCISHUI 拍板 |
| LLM 语义归档默认关闭 | 真实模型效果未红队验证 | THATPERSON_LLM_ARCHIVE=true 才启用；红队已执行（BUCISHUI 授权使用主 Key，13/13 通过），例行建议独立测试 Key | ✅ 已红队 |

## 📦 资源使用情况

| 资源类型 | 计划 | 实际 | 偏差 |
| :--- | :--- | :--- | :--- |
| 人力（人天） | 8.3 | 8.3 | 0 |
| 预算（万元） | 0 | 0 | 0（开源/本地运行） |
| API 调用 | 0 次 | 13 次 | LLM 红队真实模型 13 次请求（BUCISHUI 授权使用 Key），离线验证 0 消耗；例行建议独立测试 Key |

## 🔄 变更记录（决策记录）

| 变更编号 | 变更内容 | 原因 | 影响 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| CR-018 | 模型统一：config.model 为唯一模型来源 | chat.ts 硬编码 MODEL 与 config 展示不一致 | 请求模型以 config 为准，默认 deepseek-v4-flash | 已批准 |
| CR-019 | commander 经供应链评审提升为直接依赖 | CLI 全局子命令解析（已是 figlet 传递依赖 commander@14.0.3 MIT 官方源） | dependencies 新增 commander；核心逻辑零依赖不变 | 已批准 |
| CR-020 | bin 指向修正为 ./dist/src/cli.js | 发布前置核对发现 bin 指向旧路径 | npm 全局安装可直接执行 thatperson | 已批准 |
| CR-021 | skill.ts 修复 YAML 列表 trigger_keywords 解析 | 出厂技能自动触发不生效（frontmatter 多行列表未解析） | 「优化代码→code-op」「行业分析→industry-analysis」自动触发生效 | 已批准 |
| CR-022 | 摘要注入转义（FZ-4b 闭环） | QA 发现闭合标签经 summary 可提前闭合摘要块 | chat.ts/cli.ts 输入侧转义 < >，FZ-4b 转绿 | 已批准 |

## 📊 与上一期差异

| 维度 | 第 3 期 | 第 4 期 |
| :--- | :--- | :--- |
| 入口 | `--version` 误入对话（P0 Bug） | 全局参数解析，`--version` 输出即退出 |
| 归档 | 规则版存在正负双极性/疑问句误归档 | 否定前置检测 + 疑问词过滤 + 不确定降「中」（BC-7/8/9） |
| 元认知 | 「检查工作目录」答应但虚构 | /check directory 真实执行回传；capabilities.md + behavior.md 自查开关 |
| Skill | SKILL.md 原文回显、自动触发死代码 | 摘要层注入 + 一行加载提示 + YAML trigger_keywords 修复 |
| CLI | 仅对话循环 | 内部 7 指令 + 全局 8 指令 + 指令-执行-返回通道 |
| 界面 | 无 | ui.ts（logger/横幅/状态卡/spinner/ask）+ status 真实数据 |
| 更新 | 无 | update-check.ts（12h 缓存/跳过/静默失败/版本比较） |
| 配置 | model 只展示不参与请求 | config.model 唯一来源 + config get/set + disabledSkills 持久化 |
| 发布 | name 大写、bin 旧路径 | name=thatperson、version 1.1.0、bin 修正、npm pack 49 文件 |
| 安全 | 零依赖红线 | SEC-6 口径更新（核心零依赖 + UI 白名单）、fuzz 17 变体、FZ-4b 转义闭环 |
| 归档引擎 | 仅规则版 | + LLM 语义归档（默认关闭，可开关） |

## ✅ 本期验收标准（14 条逐条核对）

| # | 验收项 | 结果 | 证据 |
| :--- | :--- | :--- | :--- |
| ① | `--version` 修复 | ✅ | 亲验：`node dist/src/cli.js --version` 输出 `1.1.0` 即退出（exit 0，不进入对话）；parseArgs + readCurrentVersion 实现（src/cli.ts） |
| ② | 归档极性 | ✅ | BC-7/8/9 通过（tests/badcases.test.ts）：「其实我不喜欢下雨天」仅负向；「你记得我喜欢干什么嘛」疑问句不进偏好；「不确定…喜欢…」置信度降「中」待确认（src/parser/archive.ts P0 规则） |
| ③ | 元认知行为化 | ✅ | `/check directory` 与自然语言「检查工作目录」真实执行并回传结果（detectToolIntent/runTool → listDirectoryContents）；present/behavior.md 新增「能力自查开关」条目 |
| ④ | 肢觉 | ✅ | present/capabilities.md 能力清单经 loadPresent() 自动注入 System；chat.ts buildSkillsSummary 生成 `<技能清单>` 摘要层；出厂 5 技能自动触发验证通过：优化代码→code-op、帮我做行业分析→industry-analysis（frontmatter YAML trigger_keywords） |
| ⑤ | CLI 指令-执行-返回 | ✅ | `/` 前缀内部指令由 CLI 执行并回传（processInput 优先级：内部指令 > Skill > 工具通道 > 未知提示）；skill.ts parseFrontmatter 修复多行 YAML 列表（trigger_keywords 生效） |
| ⑥ | CLI 生态 | ✅ | 内部 `/help /history /clear /reset /exit /save /update` + 全局 `status / memory / session / config / skills / update / help` 全部可用（亲验 status/skills/memory/config/session 输出）；说明清单落点：资源文件 CLI生态相关\说明文档\CLI生态说明清单.md + 项目报告\第四期\CLI生态说明清单.md |
| ⑦ | 更新检查 | ✅ | tests/update-check.test.ts 全绿（12h 缓存 / force 绕过 / THATPERSON_DEV 与 G:\XXFS\ 跳过 / 404 超时静默 / 数字分段版本比较） |
| ⑧ | CLI 界面 | ✅ | src/utils/ui.ts 封装 logger/showBanner/showStatusCard/startSpinner/ask；status 卡片接真实数据（版本/模型/记忆条目/技能数量/Token 预算/目录）；报告：资源文件 CLI生态相关\CLI界面优化相关\CLI界面优化报告.md + 项目报告\第四期\CLI界面优化报告.md |
| ⑨ | 初始化 | ✅ | config.model 为唯一模型来源，默认 deepseek-v4-flash（DEFAULT_MODEL）；apiKeyGuidance()/hasApiKey() 引导首次部署无 Key 场景（不硬编码、不落日志） |
| ⑩ | 发布前置 | ✅ | 亲验：name=thatperson 小写、version 1.1.0、bin 修正为 `./dist/src/cli.js`、`npm.cmd pack --dry-run` = 49 文件（含 dist 14 项 + skills 34 项 + package.json） |
| ⑪ | 安全 | ✅ | SEC-6 口径更新（核心零依赖 + UI 依赖白名单断言）；fuzz 17 变体全绿（tests/fuzz.test.ts FZ-1~5）；FZ-4b 经摘要注入转义修复转绿（chat.ts escapeSummaryTags + cli.ts escapeTags）；LLM 红队真实模型 13/13 通过（BUCISHUI 授权，详见 安全专项\LLM红队报告-20260812.md）；测试地图.md 与 安全测试工具操作指南.md 同步落点 安全专项\ |
| ⑫ | 回归 | ✅ | 亲验 `npm.cmd test` = 111/111 全绿（tsc 双段编译 + node --test，fail 0）；ARCHITECTURE.md 与 目录树.md 本期同步 |
| ⑬ | 能力自省不泄源码 | ✅ | skills list/帮助只出名称/描述摘要/启用状态（skillsListText 截断 60 字）；触发技能只打一行「已加载技能「xx」」；SKILL.md 原文仅内部注入 LLM，不出现于回复（src/cli.ts S-06 三层分离） |
| ⑭ | 反馈闭环 | ✅ | Open\ 中两份第三期反馈已解决并移入 Done\（ThatPerson第三期试用反馈-20260811.md、ThatPerson第三期反馈诊断与下期修复计划-20260811.md，后者附「处理状态（第 4 期）」清单）；Open\ 仅剩文件夹说明.md |

## ⚠️ 遗留问题

| 编号 | 问题 | 影响 | 状态 |
| :--- | :--- | :--- | :--- |
| a | Windows 控制台管道中文乱码（第 3 期 P4 延续） | 自动化管道输入乱码 | 🔄 `--input-file` 已覆盖文件场景（UTF-8 剥 BOM），管道另行评估（待 BUCISHUI 拍板是否本期继续） |
| b | 技能关键词精确匹配敏感 | 「优化一下提示词」等变体未触发 prompt-op（其无 trigger_keywords，description 前 12 字兜底未命中） | 🔄 低危；建议后续给 prompt-op 等补 trigger_keywords 变体（待确认） |
| c | 发布动作未执行 | 全局安装仍依赖手动 shim | ⏳ 待 BUCISHUI 确认 1.1.0 后执行 `npm publish` + `npm unlink` + 真实安装验证（THATPERSON_HOME 临时目录） |
| d | LLM 语义归档默认关闭 | 功能默认关闭；红队已执行 | ✅ 红队 13/13 通过（BUCISHUI 授权使用主 Key）；功能仍默认关闭，例行红队建议独立测试 Key |

**Scribe 实测补充观察（待确认，非本期验收项）**：
1. `npm pack --dry-run` 打包内容含 `skills/vault-api-bridge/scripts/自动化脚本/__pycache__/*.pyc`（3 个）与顶层历史遗留 `dist/index.js`——不影响功能，发布前建议评估 `.npmignore`/清理，避免 tarball 带非必要文件。
2. ~~`thatperson memory stats` 输出含两行 session_logs~~——已修复（Orchestrator 集成阶段：SECTION_FILES 循环跳过 session_logs，仅保留独立统计一行）。

## 📌 下阶段计划

- [ ] 执行 npm publish + npm unlink + 真实安装验证（BUCISHUI，截止：BUCISHUI 拍板后）
- [x] 真实模型红队（LLM 语义归档 + 注入对抗）——已执行 13/13 通过（BUCISHUI 授权；例行建议配置独立测试 Key）
- [ ] 技能 trigger_keywords 变体扩充（prompt-op 等，消除精确匹配敏感）（智能核心组）
- [ ] 评估 Windows 管道输入中文编码（系统工程组）

### 需要协调的事项
- 需要 BUCISHUI 确认版本 1.1.0 与发布窗口；
- 例行红队建议配置独立低额度测试 Key（本次红队经 BUCISHUI 授权使用主 Key，13/13 通过）。

## ✍️ 审批签名

- 项目经理：BUCISHUI
- 技术负责人：BUCISHUI
- 客户代表（如需要）：BUCISHUI

---
> 状态标签：`#报告/周报` `#报告/里程碑`
> 项目标签：`#项目/Agent` `#项目/ThatPerson`
