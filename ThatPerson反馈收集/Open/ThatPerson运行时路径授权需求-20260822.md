# ThatPerson 运行时路径授权需求（allow-dir）

> **类型**：反馈 / 功能需求 / 安全设计演进
> **期次**：第 5 期（发布就绪后用户侧使用反馈）
> **日期**：2026-08-22
> **触发场景**：真实对话要求「去 `G:\XXFS\groWiki\6-日记目录` 读取 2026-07-31 日记」。工具层路径白名单（`allowedRoots = [home, cwd, cwd/.thatperson, THATPERSON_VAULT_ROOT]`）硬拒绝 `cwd` 之外路径，模型只能诚实告知无法访问；用户希望 thatperson 像 sudo 一样**在会话内申请授权并临时/持久放行**。
> **方法**：通读 `src/agent/loop.ts`（allowedRoots 构造）、`src/tools/guards.ts`（assertPathAllowed 硬拒绝）、`src/tools/executor.ts`（danger 双门控、ReAct 循环 dangerAllowed 恒 false）、`src/config.ts`（配置白名单/持久化）。

---

## 一、现状核实（代码级）

| # | 现状 | 代码证据 |
| :-- | :-- | :-- |
| 1 | 工具路径为**静态硬白名单**：`home / cwd / cwd/.thatperson / THATPERSON_VAULT_ROOT`；越界直接返回拒绝，无任何运行时授权/确认通道 | `src/agent/loop.ts` allowedRoots；`src/tools/guards.ts` assertPathAllowed 返回 `null` |
| 2 | 无「模型申请授权 → 用户批准 → 放行」流程；越界结果以 `{ok:false,error}` 回灌，模型只能告知/认输 | `src/tools/executor.ts`；`src/agent/loop.ts` 连续失败 3 次认输 |
| 3 | danger 工具（run_shell）在 ReAct 循环内恒禁用（`dangerAllowed:false`），仅有环境变量静态门，无交互确认窗口 | `src/agent/loop.ts` 调用 `executeTool(...,{dangerAllowed:false})` |
| 4 | 唯一授权手段是**启动前环境变量**（`THATPERSON_VAULT_ROOT`），运行中不可变更 | `src/agent/loop.ts` 读取 process.env |

## 二、需求描述

1. **动态授权入口**：新增全局指令 `thatperson allow-dir <绝对路径>`，把路径**持久化**写入 `~/.thatperson/config.json` 的授权白名单（新增配置键，如 `allowedDirs: string[]`），写入前 `path.resolve` + 校验为存在的目录；已存在幂等，不在白名单返回错误。
2. **越界回灌带授权提示**：工具被 `assertPathAllowed` 拒绝时，回灌内容附加「该路径不在允许目录内；如需访问请运行 `thatperson allow-dir <路径>` 授权后重试」（动态生成，不泄露路径细节之外的敏感信息）。
3. **授权即时生效**：`runAgentLoop` 的 `allowedRoots` 构造时合并 `config.allowedDirs`，授权后同一会话内重试即可命中（不要求重启）。
4. **可选交互确认（TTY）**：非 `--mock` 且 `process.stdin.isTTY` 时，首次越界可弹一次确认「是否允许访问 <路径>？(y/N)」，批准则临时加入本轮白名单并提示持久化方式；非交互（管道/--input-file）一律只回灌提示、不弹确认。

## 三、安全约束（红线不后退）

- **不静默放行**：任何授权必须来自用户显式动作（命令或 TTY 确认）；模型无法通过对话内容自行扩大白名单（SEC-10 口径保持：`<工具清单>` 静态不可注入）。
- **注入防护**：`allow-dir` 参数仅接受绝对路径，`path.resolve` 归一 + `realpath` 复检后入白名单；写入 config.json 走既有 0600 写盘；拒绝相对路径/`..`/符号链接逃逸（复用 `assertPathAllowed` 逻辑的反向校验）。
- **授权持久化安全**：`allowedDirs` 键入 `CONFIG_KEY_WHITELIST`；`config get/set` 不直接暴露完整列表的越权写入；`reset` 时保留（与 apiKey/model 同级）或按确认清理——需明确口径。
- **非交互拒绝**：管道/`--input-file`/`--mock` 不弹确认、不自动授权。
- **审计**：授权变更动作记录（可选 logs/audit），工具调用审计日志仍只记 argsKeys。

## 四、验收建议（对齐测试契约）

- `tests/config.test.ts`：`allow-dir` 持久化 / 幂等 / 非法路径拒绝 / reset 口径。
- `tests/tools.test.ts`：授权目录加入 allowedRoots 后越界→命中；未授权仍拒绝；TTY 确认分支与非交互不弹分支。
- `tests/security.test.ts`：新增 SEC 断言——对话注入无法新增白名单；`allow-dir` 参数注入（相对路径/`..`/符号链接）拒绝。
- 文档同步：`ARCHITECTURE.md`（常量/数据流/CR）、`CLI生态说明清单.md`（新指令）、`使用说明.md`（FAQ/目录）、安全审查报告。

## 五、开放问题（待确认）

1. `allowedDirs` 是否纳入 `reset` 保留集？（建议：纳入，与 apiKey/model 同级，避免误清授权）
2. TTY 逐次确认的「本轮临时放行」是否会导致自动化行为不确定？（建议：默认仅持久化命令路径，TTY 确认为可选增强）
3. 是否需要「移除授权」指令 `thatperson deny-dir <路径>`？（建议：需要，与 allow-dir 对称）

---

> 状态：Open（第 5 期结束后待排期，建议列入第 6 期需求清单）
> 关联：安全红线 3/4（路径双白名单、禁止用户输入进路径）——本需求是「白名单 + 显式用户授权」的演进，不突破红线
