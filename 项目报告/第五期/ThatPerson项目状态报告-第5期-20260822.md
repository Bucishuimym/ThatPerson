# 项目状态报告

> 项目名称：ThatPerson
> 报告期次：第 5 期
> 报告日期：2026-08-22
> 编制人：Scribe Agent（Agent Team 文档组，S-1）
> 审批人：BUCISHUI
> 验收结果：Orchestrator（O-1）已验证；QA Agent（Q-1）独立复核 **PASS**（`npm.cmd test` 156 用例：155 通过 / 1 跳过 / 0 失败）

## 📌 项目总体概况

| 项目属性 | 内容 |
| :--- | :--- |
| 项目目标 | 按第五版提示词（v2.1 正式执行版）完成第 5 期迭代，分两批次交付：批次一（归档质量三闸 / 长文本内容感知 / 首次部署体验闭环 / 定位管家与去比喻）→ 批次二（工具层 / Function Calling / ReAct 编排 / 技能→工具桥接 / 新功能接线 / 安全收口 / 发布就绪） |
| 项目范围 | 归档三闸（D4~D6）与长文本内容模式（D7/D8）、首次部署目录时机（D9/D15）、setup 向导与 Key 同源（D10/D11）、Key 安全配套（0600/掩码）、reset、present init/show、定位「个人管家」去比喻（D13/D14）、工具层（src/tools/：types/registry/guards/executor/builtin）、ReAct 循环（src/agent/loop.ts）、Function Calling（chat.ts tools+tool_choice）、技能→工具桥接（skill.ts tools 声明）、edit_present / append_memory / LLM 语义归档增强（M2）、安全收口（SEC-10~12 + 工具层红队）、发布就绪（1.2.0 / REGISTRY_URL 对齐 / npm pack 核验） |
| 当前阶段 | 开发（已进入发布验收） |
| 总体进度 | 计划 100% vs 实际 100%（批次一 10 项 + 批次二 11 项验收全部通过） |
| 项目健康度 | 🟢正常（无阻塞；npm publish 与真实 Key 实证待 BUCISHUI 执行） |

## 🏁 里程碑与关键交付物

| 里程碑名称 | 计划日期 | 实际日期 | 状态 |
| :--- | :--- | :--- | :--- |
| R-1 Key Specs 提炼（第5期-KeySpecs-20260822.md，24 条硬规格） | 2026-08-22 | 2026-08-22 | ✅ 已完成 |
| R-1 反馈转任务清单（第5期-反馈转任务清单-20260822.md，46 条任务） | 2026-08-22 | 2026-08-22 | ✅ 已完成 |
| 批次一：归档三闸（单句单条目/占位词黑名单/不确定不产经历） | 2026-08-22 | 2026-08-22 | ✅ 已完成（BC-10/11/12 通过） |
| 批次一：长文本内容感知（内容模式/全文归档/先回应内容/检索段落化） | 2026-08-22 | 2026-08-22 | ✅ 已完成 |
| 批次一：部署体验闭环（目录时机/setup 向导/resolveApiKey/reset/present init） | 2026-08-22 | 2026-08-22 | ✅ 已完成 |
| 批次一：定位管家与去比喻（src/present/package.json 去「=大脑/=手/=记忆」） | 2026-08-22 | 2026-08-22 | ✅ 已完成 |
| 批次一 QA 门禁（Q-1 一票否决） | 2026-08-22 | 2026-08-22 | ✅ PASS |
| 批次二：工具层（src/tools/ 全量，默认注册 7 工具 + run_shell 门控） | 2026-08-22 | 2026-08-22 | ✅ 已完成（tests/tools.test.ts 17 条） |
| 批次二：Function Calling + ReAct 循环（src/agent/loop.ts，MAX_TOOL_ITERATIONS=5） | 2026-08-22 | 2026-08-22 | ✅ 已完成（loop 3 路径测试通过） |
| 批次二：技能→工具桥接 + 新功能接线（edit_present/append_memory/M2） | 2026-08-22 | 2026-08-22 | ✅ 已完成（KS-21 桥接测试通过） |
| 批次二：安全收口（SEC-10/11/12 + 工具层红队） | 2026-08-22 | 2026-08-22 | ✅ 已完成 |
| 反馈闭环（Open/ 4 份反馈移入 Done/） | 2026-08-22 | 2026-08-22 | ✅ 已完成 |
| 发布就绪（version 1.2.0 / REGISTRY_URL 对齐 scoped 包名 / npm pack 58 文件） | 2026-08-22 | 2026-08-22 | ✅ 已完成（publish 待 BUCISHUI） |
| 行动闭环 --mock 实证（read_vault_note → 审计日志 argsKeys） | 2026-08-22 | 2026-08-22 | ✅ 已完成 |
| 三件套 + ARCHITECTURE/目录树/安全文档同步 | 2026-08-22 | 2026-08-22 | ✅ 已完成 |

## 📊 进度详情

| 任务 | 负责人 | 计划工时 | 实际工时 | 状态 | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Key Specs 提炼（24 条） | R-1（研究） | 0.5 | 0.5 | ✅ | 项目报告\第五期\第5期-KeySpecs-20260822.md |
| 反馈转任务清单（46 条） | R-1（研究） | 0.5 | 0.5 | ✅ | 项目报告\第五期\第5期-反馈转任务清单-20260822.md |
| 归档三闸（KS-1~3） | D-1（数据质量） | 0.5 | 0.5 | ✅ | src/parser/archive.ts；BC-10/11 通过 |
| 长文本内容模式（KS-4~6） | D-1（数据质量） | 0.5 | 0.5 | ✅ | cli.ts 内容模式 + extractContentModeArchives；BC-12 通过 |
| 部署体验闭环（KS-7~11） | D-2（产品与部署） | 1 | 1 | ✅ | src/config.ts/setup.ts/cli.ts；ensureConfigDir 上移 |
| 定位与去比喻（KS-12~14） | D-2（产品与部署） | 0.5 | 0.5 | ✅ | 人格句「个人管家」；src/present/package.json 中性化 |
| present init/show（KS-13） | D-2（产品与部署） | 0.5 | 0.5 | ✅ | src/present.ts 级联 + 空提醒 |
| 工具层（KS-17/18） | D-3（工具与引擎） | 1.5 | 1.5 | ✅ | src/tools/ 全量；tests/tools.test.ts 17 条 |
| Function Calling + ReAct（KS-19/20） | D-3（工具与引擎） | 1.5 | 1.5 | ✅ | chat.ts tools + src/agent/loop.ts；loop 3 路径 |
| 技能→工具桥接（KS-21） | D-3（工具与引擎） | 0.5 | 0.5 | ✅ | skill.ts tools 声明；vault-api-bridge 声明 3 工具 |
| 新功能接线（KS-22） | D-3（工具与引擎）+ D-2 | 1 | 1 | ✅ | edit_present/append_memory；llm-archive M2 增强 |
| 安全收口（KS-23） | D-4（质量保障） | 1 | 1 | ✅ | SEC-10~12 + 工具层红队 + 测试地图/操作指南同步 |
| 行动闭环实证（KS-24） | O-1 + D-3 | 0.5 | 0.5 | ✅ | --mock stub 全链路 + 审计日志 argsKeys 实证 |
| 发布就绪（KS-24） | O-1 + D-3 | 0.5 | 0.5 | ✅ | 1.2.0 / REGISTRY_URL / npm pack 58 文件 |
| 反馈闭环归档 | S-1（记录） | 0.3 | 0.3 | ✅ | Open/ 4 份移入 Done/（后缀 -已处理20260822） |
| 三件套 + 文档同步 | S-1（记录） | 1 | 1 | ✅ | 项目报告\第五期\ + ARCHITECTURE/目录树/README/使用说明/安全文档 |

## ✅ 验收清单（按第五版提示词逐条）

### 批次一验收（10/10）

| # | 验收项 | 结果 | 证据 |
| :--- | :--- | :--- | :--- |
| ① | 归档三闸 | ✅ | BC-10/11/12 通过；「用户喜欢「事情」」消失；同句双条目消失；不确定不产经历 |
| ② | 长文本内容感知 | ✅ | 日记长文本（>200 字）内容模式归档 ≥1 条；回复指令「先回应内容再回应动作」；检索段落化命中 |
| ③ | 首次部署目录 | ✅ | 全新 HOME 执行 `thatperson --version` 后 `~/.thatperson/` 含 config.json + present/skills/logs/history（ensureConfigDir 上移 main 最前） |
| ④ | setup 向导 | ✅ | 无 Key 自动弹向导仅一次（TTY 且未 configured）；`setup`/`wizard` 可重跑；`--version/--help/--mock`/管道不弹 |
| ⑤ | reset | ✅ | `thatperson reset` 后仅保留 apiKey + model；disabledSkills/present 覆盖/会话清空 |
| ⑥ | Key 同源 | ✅ | `resolveApiKey` 优先级（环境变量 > config.json > .env）生效；`config set apiKey` 白名单生效；status/get apiKey 掩码；config.json 0600 |
| ⑦ | 定位与去比喻 | ✅ | 人格句=「个人管家」；src/present/package.json 无「=大脑/=手/=记忆」比喻（ARCHITECTURE 保留心智模型并标注例外） |
| ⑧ | present 提醒/init | ✅ | 空 present 提醒出现；`present init/show` 可用（不覆盖既有文件） |
| ⑨ | 回归 | ✅ | `npm.cmd test` 全绿（111 + 批次一新增）；三个实测反例转正 |
| ⑩ | 批次一交付 | ✅ | 批次一三件套落盘 `项目报告\第五期\`；ARCHITECTURE/目录树同步；`history/` 入 .gitignore；反馈 Open→Done |

### 批次二验收（11/11）

| # | 验收项 | 结果 | 证据 |
| :--- | :--- | :--- | :--- |
| ① | 工具注册表 | ✅ | tests/tools.test.ts 列出 7 个 read/write 工具（≥5）；未注册 name 返回 unknown-tool 拒绝 |
| ② | 守卫与执行器 | ✅ | 路径穿越（`../`、白名单外、符号链接 realpath 复检）全部拒绝；参数校验通过；结果截断（RESULT_CHAR_LIMIT=4000）；danger 默认禁用 |
| ③ | Function Calling | ✅ | chat() 带 tools + tool_choice:'auto'；tools 缺省时 111 既有测试不改一行仍全绿 |
| ④ | ReAct 循环 | ✅ | loop 测试 3 路径（5 轮上限/失败重试→成功/失败→认输）；解析器/执行器/回灌器分离；审计日志落盘 |
| ⑤ | 技能→工具桥接 | ✅ | vault-api-bridge 的 `tools:` 声明注册生效；Skill 扫描目录口径统一（主目录→随身→包内级联）；SKILL.md 原文不进 System |
| ⑥ | present 自动填入 | ✅ | `edit_present` 写对文件且不覆盖冲突（append/replace 语义 + 冲突拒绝） |
| ⑦ | 主动记忆写入 | ✅ | `append_memory` 即时落盘（追加不覆盖） |
| ⑧ | 经历情绪化写入 | ✅ | 先回应内容指令生效；LLM 语义归档默认关、`--mock` 走规则兜底；M2 增强（独立 Key/insight 概括/同条去重/不确定规则） |
| ⑨ | 工具层安全 | ✅ | SEC-10/11/12 通过；工具层红队用例通过；测试地图/操作指南同步更新 |
| ⑩ | 行动闭环（完成定义） | ✅ | `--mock` stub 注入 read_vault_note → 解析→执行→回灌→再推理三段跑通 + 审计日志 `logs/tool-*.jsonl` 只记 `argsKeys:["date"]` |
| ⑪ | 回归与发布准备 | ✅ | `npm.cmd test` 全量通过（156 用例：155 通过/1 跳过/0 失败）；version 1.2.0；REGISTRY_URL 对齐 scoped 包名；npm pack 58 文件（162.5kB）含 src/tools、src/agent、skills，不含 history/.env/API-key；README/使用说明更新 |

## ⚠️ 风险与问题

| 风险描述 | 影响 | 应对措施 | 状态 |
| :--- | :--- | :--- | :--- |
| npm publish 尚未执行 | 全局安装仍走手动 shim，更新检查实际指向注册表 | 已备好 npm pack 58 文件核验结果（162.5kB）+ 1.2.0 版本，待 BUCISHUI 确认后执行 `npm publish` + 全局安装验证 | ⏳ 待 BUCISHUI 拍板 |
| 真实 Key 实证未执行 | 第 5 期完成定义要求真实 Key 实证一次「读取 2026-07-31 日记」 | 红线要求不消耗主 Key、不随意调用 API 里的 Key——实证步骤已写入交接说明，留给 BUCISHUI 手动执行（隔离 home + 独立测试 Key 优先） | ⏳ 待 BUCISHUI 手动执行 |
| git 索引异常（src/config.ts D+??，index.lock 权限拒绝） | 工作区状态未归一，暂存区与工作区不一致 | 本会话 `.git` 只读，需在真实 git 客户端执行 `git add -A && git status` 归一；不提交、不 push（提示词要求待确认） | 🔄 待真实 git 环境处理 |
| LLM 语义归档默认关闭 | 真实模型语义归档效果未行为级验证 | THATPERSON_LLM_ARCHIVE=true 才启用；`--mock` 离线兜底已全绿；例行红队建议独立低额度测试 Key | 🔄 待后续例行 |

## 📌 下阶段计划

- [ ] BUCISHUI 确认 1.2.0 后执行 `npm publish` + 全局安装验证（THATPERSON_HOME 临时目录）（负责人：BUCISHUI）
- [ ] 真实 Key 实证一次「从知识库读取 2026-07-31 日记」：隔离 home、独立测试 Key 优先、回复先回应内容（负责人：BUCISHUI）
- [ ] 真实 git 环境执行 `git add -A && git status` 归一索引（src/config.ts 状态复位）（负责人：BUCISHUI）
- [ ] 例行安全红队：真实模型行为级验证（SEC-10~12 补充用例）建议配置独立低额度测试 Key（负责人：D-4，截止：下期）

### 需要协调的事项

- 待确认：1.2.0 版本是否发布（更新检查 REGISTRY_URL 已对齐 scoped 包名，发布后即可正常提示升级）
- 待确认：工具层 `run_shell` 门控策略（默认 `THATPERSON_ENABLE_SHELL=true` + 用户逐次确认；默认不注册）

## ✍️ 审批签名

- 项目经理：BUCISHUI
- 技术负责人：BUCISHUI
- 客户代表（如需要）：BUCISHUI

---
> 状态标签：`#报告/里程碑` `#项目/Agent`
> 项目标签：`#项目/ThatPerson` `#项目/知识库`
