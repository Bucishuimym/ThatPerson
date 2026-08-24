# ThatPerson CLI 生态说明清单（第 5 期）

> 日期：2026-08-22（第 4 期 2026-08-12 建立，第 5 期更新）
> 适用范围：ThatPerson v1.2.0 全部 CLI 指令（内部指令 / 全局指令 / 全局参数 / Skill 触发 / 工具层 / 配置向导）
> 代码落点：`src/cli.ts`（parseArgs / createInternalCommands / runGlobalCommand / processInput / runAgentLoop 接线）、`src/config.ts`、`src/setup.ts`、`src/skill.ts`、`src/tools/`、`src/agent/loop.ts`、`src/utils/update-check.ts`
> 说明：本清单为指令的「命令 / 作用 / 示例输出」完整说明；示例输出为真实运行采样（`node dist/src/cli.js …`，Windows + Node 24，隔离 `THATPERSON_HOME`）。

## 〇、指令优先级（对话内）

```
内部指令表（/help /history /clear /reset /exit /save /update）
  > Skill 斜杠命令（/<技能名>）
  > 工具通道（模型经 Function Calling 调用已注册工具，走 ReAct 循环）
  > 自然语言（Skill auto 触发 / 普通对话）
```
- 全部 `/` 前缀内部指令由 CLI 本地处理，**不发送给模型**。
- 全局入口：有子命令（positional[0]）走全局指令；无参数才进入持续对话。
- 第 5 期变化：普通对话消息走 `runAgentLoop`（ReAct 循环，最多 12 轮工具调用，`THATPERSON_MAX_TOOL_ITERATIONS` 可调）；原 `/check directory` 指令-执行-返回通道并入 `list_directory` 工具，内部指令优先级不变。

## 一、全局参数（thatperson …）

| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson` | 进入持续对话模式（无参数）；无 Key 且未 configured 时（TTY）自动弹出配置向导 | 横幅 + `[ThatPerson] 持续对话模式已开启…` + `你：` |
| `thatperson --mock` | 离线演示模式（不调用 API、不发网络、不读 Key） | 横幅 + `（离线演示，不调用 API）…` |
| `thatperson --input-file <path>` | 从文件读入指令（UTF-8 剥 BOM），单次对话后退出 | 文件内容作为一条用户消息处理并退出 |
| `thatperson --version` / `-V` | 输出版本号后退出；**任意调用都会保证 `~/.thatperson/` 目录存在**（config.json + present/skills/logs/history） | `1.2.0` |
| `thatperson --help` / `-h` | 打印内部 + 全局指令帮助后退出 | 见下文「帮助输出」 |

> 非交互入口（`--version` / `--help` / `--mock` / `--input-file` / 管道）一律**不弹**配置向导。

## 二、内部指令（对话内输入，不送模型）

| 指令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `/help` | 显示内部指令帮助 | 同 `thatperson --help` 的帮助文本 |
| `/history` | 查看当前会话消息数与最近 2 轮摘要 | `当前会话共有 4 条消息。` + 最近 2 轮「用户/ThatPerson」内容 |
| `/clear` | 清空终端屏幕（不影响会话） | `console.clear()`，无文本 |
| `/reset` | 重置当前会话（清空历史/摘要/近期输入，不落盘） | `会话已重置` |
| `/exit` | 退出程序 | `再见 👋` |
| `/save` | 将当前会话保存为快照（history/sessions/，不覆盖同名） | `✔ 已保存会话快照：…\history\sessions\session-20260822-153000.md` |
| `/update` | 手动检查更新（绕过 12h 缓存；跳过策略仍生效） | `ℹ 正在检查更新…` →（有新版时）`✨ ThatPerson 新版本 x.y.z 可用！…` → `ℹ 更新检查完成` |

> 退出对话的等效命令（非 `/` 前缀）：`exit / quit / 退出 / 再见`。

## 三、全局指令（thatperson <子命令>）

### 3.1 系统状态
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson status` | 输出状态卡片（版本/模型/API Key 掩码/记忆条目/技能数量/Token 预算/工作目录/全局目录）后退出 | 见下方「status 卡片示例」 |
| `thatperson update` | 手动检查更新（同 `/update`，force 绕过缓存） | `ℹ 正在检查更新…` |
| `thatperson help` | 打印帮助后退出 | 同 `--help` |

**status 卡片示例（真实数据采样，API Key 掩码回显）**
```
╭────────────────────────────  📊 系统状态  ─────────────────────────────╮
│                                                                        │
│   版本: 1.2.0                                                          │
│   模型: deepseek-v4-flash                                              │
│   API Key: sk-***fd91                                                  │
│   记忆条目: 5 条                                                       │
│   技能数量: 5 个                                                       │
│   Token 预算: 16000 / 轮                                               │
│   工作目录: G:\XXFS\Webstorm\project\Aagent\ThatPerson                 │
│   全局目录: C:\Users\<user>\.thatperson                                │
│                                                                        │
╰────────────────────────────────────────────────────────────────────────╯
ℹ 状态检查完毕
```
> 无 Key 时显示 `API Key: 未配置`（不打印明文，掩码只回显末 4 位）。

### 3.2 首次配置与 Key 管理（第 5 期新增）
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson setup` | 首次配置向导：显示 home 与 config.json 路径 → password 掩码输入 API Key → 选择/确认默认模型 → 写回 config.json（新增 apiKey + configured:true，保留既有字段） | 交互式多步；Key 输入为掩码（`****`），不打印不落日志 |
| `thatperson wizard` | setup 的别名 | 同上 |
| `thatperson reset` | 重置配置（仅保留 apiKey 与 model；disabledSkills/present 覆盖/会话清空；`--keep-present` 保留 present 覆盖） | `已重置配置（仅保留 apiKey 与 model）。对话内 /reset 仅清会话，语义不同。` |

**Key 同源优先级（resolveApiKey）**：环境变量 `AAGENTDS_API_KEY` > `config.json.apiKey` > 包目录 `.env`（兼容）。
- `thatperson config set apiKey <Key>` 可用（白名单新增 apiKey），掩码存储于 config.json（0600 写盘）。
- 无 Key 且未 configured 时进入对话自动弹向导（仅 TTY 一次；configured 后不再打扰）。

### 3.3 记忆管理
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson memory search <关键词>` | 在五维归档文件中按关键词输出命中行 | `[profile] - **原始对话片段**：<dialog>"…篮球…"</dialog>` |
| `thatperson memory stats` | 输出各 section 条目数与 session_logs 篇数 | `  profile: 1 条`、`  timeline: 0 条`、…、`  session_logs: 2 篇` |
| `thatperson memory clean` | 对归档文件执行压缩清理（去重/低置信度衰减/标签合并/软上限） | `已对 7 个归档文件执行压缩清理` |

> 记忆目录（第 5 期口径）：存在 `<cwd>/.thatperson/` 时记忆落随身目录 `history/`；否则落主目录 `~/.thatperson/history/`（`THATPERSON_MEMORY_DIR` 优先级最高）。

### 3.4 会话
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson session list` | 列出 history/session_logs/ 下的历史会话（新在前） | `  2026-08-22.md`、`  2026-08-21.md` |
| `thatperson session clear` | 全局命令模式下清空会话（当前无活动中的会话，提示对话内用 `/reset`） | `全局命令模式下没有活动中的会话（可在持续对话内用 /reset 清空当前会话）` |

### 3.5 配置
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson config get` | 输出配置全量（配置文件路径/模型/API Key 掩码/禁用技能/已配置标记） | `配置文件：…\config.json`、`模型：deepseek-v4-flash`、`API Key：sk-***fd91`、`禁用技能：（无）`、`已配置：是` |
| `thatperson config get <key>` | 输出单个白名单键（model / disabledSkills / apiKey） | `model: deepseek-v4-flash`；`apiKey` → `sk-***fd91`（未设置 → `未设置 API Key`） |
| `thatperson config set <key> <value>` | 修改配置（key 白名单含 apiKey；值非空；不静默覆盖损坏文件） | `已写入配置：apiKey` |

### 3.6 技能
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson skills list` | 列出已安装技能与启用状态（名称 + 描述摘要 60 字 + 状态） | `  code-op （启用） - 代码优化 Skill。当用户要求优化/重构/改进/审查/检查代码…` |
| `thatperson skills enable <名称>` | 启用技能（从 disabledSkills 移除，幂等） | `已启用技能：code-op` |
| `thatperson skills disable <名称>` | 禁用技能（持久化到 disabledSkills，幂等） | `已禁用技能：code-op` |

> 技能扫描目录级联（第 5 期统一口径）：主目录 `~/.thatperson/skills/` > 随身目录 `<cwd>/.thatperson/skills/` > 包内出厂 `skills/`。

### 3.7 人格（第 5 期新增）
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson present init` | 生成出厂人格模板到主目录 present/（不覆盖既有文件） | 首次：`已生成人格模板：behavior.md、capabilities.md、identity.md、output.md、persona.md`；再次：`已存在未覆盖：behavior.md、capabilities.md、…` |
| `thatperson present show` | 查看当前生效人格（主目录→随身目录→出厂级联后的文本） | 输出人格正文（空时提示 `（当前无生效人格，可运行 thatperson present init 生成模板）`） |

### 3.8 工具层（第 5 期新增）
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson tools list` | 列出已注册工具（名称 + 权限 read/write/danger + 参数 + 描述摘要 60 字） | `已注册工具（7 个）：` + 每行 `  list_directory（read，dir?）：列出指定目录…` |

**默认注册 7 个工具**（第 5 期批次二）：
- read×5：`list_directory` / `read_file` / `read_vault_note`（path 或 date）/ `search_vault` / `search_memory`
- write×2：`append_memory`（即时写入记忆）/ `edit_present`（编辑人设，冲突拒绝覆盖）
- danger×1：`run_shell` —— **默认不注册**，仅当 `THATPERSON_ENABLE_SHELL=true` 且逐次确认后才可用（双门控，SEC-12）。

## 四、Skill 触发说明

- **斜杠调用**：`/<技能名>`（支持 ≥2 字符前缀匹配），如 `/code-op`；触发时输出一行摘要 `已加载技能「code-op」`，SKILL.md 全文仅内部注入 LLM，不回显。
- **自动触发**：自然语言命中 frontmatter `trigger_keywords`（精确包含匹配）即触发；其次 description 前 12 字片段包含兜底。
  - 出厂 5 技能：code-op / industry-analysis / prompt-op / vault-api-bridge / warehouses-management。
  - 示例：说「优化代码」→ 触发 code-op；说「帮我做行业分析」→ 触发 industry-analysis。
- **工具桥接（第 5 期）**：SKILL.md frontmatter 可声明 `tools:`（如 vault-api-bridge 声明 `read_vault_note / search_vault / search_memory`），触发该技能时声明的工具动态注册进本轮工具列表（技能 = 工具组合说明书，执行归工具层）。
- **优先级**：内部指令 > Skill 斜杠命令 > 工具通道 > 自然语言（Skill auto / 普通对话）。
- 已知边界（低危，待确认）：关键词为精确包含匹配，变体如「优化一下提示词」可能不触发 prompt-op（其无 trigger_keywords，description 兜底未命中）；可用 `/prompt-op` 直接调用。

## 五、工具通道与 ReAct 循环（第 5 期批次二）

| 入口 | 作用 | 说明 |
| :--- | :--- | :--- |
| 普通对话消息 | 模型按需调用已注册工具（Function Calling，tool_choice:auto） | 走 `runAgentLoop`：解析（截取 tool_calls）→ 执行（executor，守卫/路径白名单/截断）→ 回灌（role=tool）→ 再推理；`MAX_TOOL_ITERATIONS=12` 硬上限（`THATPERSON_MAX_TOOL_ITERATIONS` 可调），连续失败 3 次诚实认输 |
| 「从知识库读取某日日记」 | 命中 `read_vault_note`（path 或 date）真实读取 | 示例：`read_vault_note({date:"2026-07-31"})`；路径须在白名单（home / cwd / cwd/.thatperson / THATPERSON_VAULT_ROOT） |
| 「现在记住 XXX」 | 命中 `append_memory` 即时落盘 | 追加不覆盖，复用归档格式（偏好/经历/日期/身份） |
| 「现在你的名字叫 XXX」 | 命中 `edit_present` 写入 present/identity.md | append/replace 语义；冲突内容拒绝覆盖 |
| 原 `/check directory` | 能力并入 `list_directory` 工具 | 内部指令优先级不变；仅列目录不读文件 |
| `--mock` 离线实证 | `THATPERSON_MOCK_TOOL_CALLS` 注入工具调用 | 例：`[{"name":"read_vault_note","arguments":"{\"date\":\"2026-07-31\"}"}]`；不读 Key、不发网络 |

**审计**：工具调用全记录 `logs/tool-*.jsonl`（时间/工具/argsKeys/状态/耗时），**只记参数键名不记参数值**，可回放调试。

## 六、长文本内容模式（第 5 期批次一）

- 用户输入 > 200 字（日记/文章等）自动进入**内容模式**：`[ThatPerson] 内容模式：检测到长文本，按全文分析归档`。
- 归档输入 = 全文（整体分析，不截首句）；规则/LLM 均无产出时走内容通道归档 ≥1 条经历。
- 回复指令：用户分享具体内容时，**先回应内容本身，再回应动作**（消除「只在意发日记这个动作」）。
- 检索语料按**段落**入库（段落级命中，避免整篇命中挤占 Top-K≤12）。

## 七、更新检查行为摘要

- 启动时异步检查（仅非 `--mock`）；12h 缓存落 `~/.thatperson/.last-update-check`（`THATPERSON_HOME` 重定向生效）。
- 跳过策略：`THATPERSON_DEV=true` 或 cwd 以 `G:\XXFS\` 开头时跳过（本地开发 / 包未发布 404 绕过）。
- 静默失败：404 / 网络错误 / 超时 / JSON 解析失败 / 缓存写失败全部静默返回，不阻塞启动。
- 版本比较：数字分段（1.10.0 > 1.9.0）；仅 `latest > current` 时输出 `✨ ThatPerson 新版本 {latest} 可用！当前 {current}。升级：npm install -g thatperson@latest`。
- 第 5 期变更：`REGISTRY_URL` 已对齐 scoped 包名 `https://registry.npmjs.org/@nineteenfolk%2fthatperson/latest`（发布后更新检查可正常查询）；升级提示中的包名文案仍为 `thatperson@latest`（既有文案，发布时以实际安装包名为准）。

---

> 标签：`#CLI生态` `#项目/ThatPerson`
