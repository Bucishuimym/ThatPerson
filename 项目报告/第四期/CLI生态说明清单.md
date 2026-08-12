# ThatPerson CLI 生态说明清单（第 4 期）

> 日期：2026-08-12
> 适用范围：ThatPerson v1.1.0 全部 CLI 指令（内部指令 / 全局指令 / 全局参数 / Skill 触发）
> 代码落点：`src/cli.ts`（parseArgs / createInternalCommands / runGlobalCommand / processInput）、`src/config.ts`、`src/skill.ts`、`src/utils/update-check.ts`
> 说明：本清单为指令的「命令 / 作用 / 示例输出」完整说明；示例输出为真实运行采样（`node dist/src/cli.js …`，Windows + Node 24）。

## 〇、指令优先级（对话内 `/` 前缀）

```
内部指令表（/help /history /clear /reset /exit /save /update）
  > Skill 斜杠命令（/<技能名>）
  > 指令-执行-返回通道（/check …）
  > 未知命令提示
```
- 全部 `/` 指令由 CLI 本地处理，**不发送给模型**。
- 全局入口：有子命令（positional[0]）走全局指令；无参数才进入持续对话。

## 一、全局参数（thatperson …）

| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson` | 进入持续对话模式（无参数） | 横幅 + `[ThatPerson] 持续对话模式已开启…` + `你：` |
| `thatperson --mock` | 离线演示模式（不调用 API、不发网络） | 横幅 + `（离线演示，未调用 API）…` |
| `thatperson --input-file <path>` | 从文件读入指令（UTF-8 剥 BOM），单次对话后退出 | 文件内容作为一条用户消息处理并退出 |
| `thatperson --version` / `-V` | 输出版本号后退出 | `1.1.0` |
| `thatperson --help` / `-h` | 打印内部 + 全局指令帮助后退出 | 见下文「帮助输出」 |

## 二、内部指令（对话内输入，不送模型）

| 指令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `/help` | 显示内部指令帮助 | 同 `thatperson --help` 的帮助文本 |
| `/history` | 查看当前会话消息数与最近 2 轮摘要 | `当前会话共有 4 条消息。` + 最近 2 轮「用户/ThatPerson」内容 |
| `/clear` | 清空终端屏幕（不影响会话） | `console.clear()`，无文本 |
| `/reset` | 重置当前会话（清空历史/摘要/近期输入，不落盘） | `会话已重置` |
| `/exit` | 退出程序 | `再见 👋` |
| `/save` | 将当前会话保存为快照（history/sessions/，不覆盖同名） | `✔ 已保存会话快照：…\history\sessions\session-20260812-143000.md` |
| `/update` | 手动检查更新（绕过 12h 缓存；跳过策略仍生效） | `ℹ 正在检查更新…` →（有新版时）`✨ ThatPerson 新版本 x.y.z 可用！…` → `ℹ 更新检查完成` |

> 退出对话的等效命令（非 `/` 前缀）：`exit / quit / 退出 / 再见`。

## 三、全局指令（thatperson <子命令>）

### 3.1 系统状态
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson status` | 输出状态卡片（版本/模型/记忆条目/技能数量/Token 预算/工作目录/全局目录）后退出 | 见下方「status 卡片示例」 |
| `thatperson update` | 手动检查更新（同 `/update`，force 绕过缓存） | `ℹ 正在检查更新…` |
| `thatperson help` | 打印帮助后退出 | 同 `--help` |

**status 卡片示例（真实数据采样）**
```
╭──────────────────────────────  📊 系统状态  ──────────────────────────────╮
│   版本: 1.1.0                                                              │
│   模型: deepseek-v4-flash                                                  │
│   记忆条目: 5 条                                                           │
│   技能数量: 5 个                                                           │
│   Token 预算: 6000 / 轮                                                    │
│   工作目录: G:\XXFS\Webstorm\project\Aagent\ThatPerson                     │
│   全局目录: C:\Users\<user>\.thatperson                                    │
╰────────────────────────────────────────────────────────────────────────────╯
ℹ 状态检查完毕
```

### 3.2 记忆管理
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson memory search <关键词>` | 在五维归档文件中按关键词输出命中行 | `[profile] - **原始对话片段**：<dialog>"…篮球…"</dialog>` |
| `thatperson memory stats` | 输出各 section 条目数与 session_logs 篇数 | `  profile: 1 条`、`  timeline: 0 条`、…、`  session_logs: 2 篇` |
| `thatperson memory clean` | 对归档文件执行压缩清理（去重/低置信度衰减/标签合并/软上限） | `已对 7 个归档文件执行压缩清理` |

### 3.3 会话
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson session list` | 列出 history/session_logs/ 下的历史会话（新在前） | `  2026-08-10.md`、`  2026-08-09.md` |
| `thatperson session clear` | 全局命令模式下清空会话（当前无活动中的会话，提示对话内用 `/reset`） | `全局命令模式下没有活动中的会话（可在持续对话内用 /reset 清空当前会话）` |

### 3.4 配置
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson config get` | 输出配置全量（配置文件路径/模型/禁用技能） | `配置文件：…\config.json`、`模型：deepseek-v4-flash`、`禁用技能：（无）` |
| `thatperson config get <key>` | 输出单个白名单键（model / disabledSkills） | `model: deepseek-v4-flash` |
| `thatperson config set <key> <value>` | 修改配置（key 白名单；值非空；不静默覆盖损坏文件） | `已写入配置：model` |

### 3.5 技能
| 命令 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `thatperson skills list` | 列出已安装技能与启用状态（名称 + 描述摘要 60 字 + 状态） | `  code-op （启用） - 代码优化 Skill。当用户要求优化/重构/改进/审查/检查代码…` |
| `thatperson skills enable <名称>` | 启用技能（从 disabledSkills 移除，幂等） | `已启用技能：code-op` |
| `thatperson skills disable <名称>` | 禁用技能（持久化到 disabledSkills，幂等） | `已禁用技能：code-op` |

## 四、Skill 触发说明

- **斜杠调用**：`/<技能名>`（支持 ≥2 字符前缀匹配），如 `/code-op`；触发时输出一行摘要 `已加载技能「code-op」`，SKILL.md 全文仅内部注入 LLM，不回显。
- **自动触发**：自然语言命中 frontmatter `trigger_keywords`（精确包含匹配）即触发；其次 description 前 12 字片段包含兜底。
  - 出厂 5 技能：code-op / industry-analysis / prompt-op / vault-api-bridge / warehouses-management。
  - 示例：说「优化代码」→ 触发 code-op；说「帮我做行业分析」→ 触发 industry-analysis。
- **优先级**：内部指令 > Skill 斜杠命令 > 工具通道 > 自然语言（Skill auto / 工具意图 / 普通对话）。
- 已知边界（低危，待确认）：关键词为精确包含匹配，变体如「优化一下提示词」可能不触发 prompt-op（其无 trigger_keywords，description 兜底未命中）；可用 `/prompt-op` 直接调用。

## 五、指令-执行-返回通道（工具）

| 命令 / 自然语言 | 作用 | 示例输出 |
| :--- | :--- | :--- |
| `/check directory` | 列出当前工作目录内容（白名单仅目录列举，不读文件） | `目录 G:\… 下共 20 项：` + 前 50 项名称 |
| `/check dir` / `/check 目录` / `/check 工作目录` | 同上别名 | 同上 |
| 「检查工作目录」「查看当前目录」「目录里有什么」 | 自然语言意图 → 真实执行并回传 LLM | 同上（作为 `[指令执行结果]` 注入本轮 LLM） |
| 其他 check 参数 | 诚实拒绝 | `（暂不支持该检查项，目前仅支持：check directory）` |

## 六、更新检查行为摘要

- 启动时异步检查（仅非 `--mock`）；12h 缓存落 `~/.thatperson/.last-update-check`（`THATPERSON_HOME` 重定向生效）。
- 跳过策略：`THATPERSON_DEV=true` 或 cwd 以 `G:\XXFS\` 开头时跳过（本地开发 / 包未发布 404 绕过）。
- 静默失败：404 / 网络错误 / 超时 / JSON 解析失败 / 缓存写失败全部静默返回，不阻塞启动。
- 版本比较：数字分段（1.10.0 > 1.9.0）；仅 `latest > current` 时输出 `✨ ThatPerson 新版本 {latest} 可用！当前 {current}。升级：npm install -g thatperson@latest`。

---

> 标签：`#CLI生态` `#项目/ThatPerson`
