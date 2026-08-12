# ThatPerson CLI 界面优化报告（第 4 期）

> 日期：2026-08-12
> 对象：`src/utils/ui.ts`（第 4 期新增，KeySpecs S-09/S-10）
> 结论：CLI 表现层统一封装完成——日志分级、启动横幅、状态卡片、加载动画、交互问答五项能力收敛到单一模块；`thatperson status` 状态卡片全部接真实数据（无占位示例）。

## 一、封装概览（ui.ts 导出清单）

| 导出 | 签名 | 作用 | 依赖 |
| :--- | :--- | :--- | :--- |
| `logger` | `{ info, success, warn, error, debug, title }`，各 `(msg: string) => void` | 分级日志：info/success/warn/error/debug 带 log-symbols 图标与颜色，title 加粗蓝字标题 | chalk + log-symbols |
| `showBanner` | `(version: string) => void` | 启动横幅：figlet 'Small' 字体的 ThatPerson + 版本行 | figlet + chalk |
| `showStatusCard` | `(title: string, lines: Record<string, string>) => void` | 状态卡片：boxen 圆角蓝边卡片，title 居中，键值对逐行输出 | boxen + chalk |
| `startSpinner` | `(text: string) => { succeed, fail, stop, text }` | 加载动画：ora cyan spinner，返回受控句柄（succeed/fail/stop/改文本） | ora |
| `ask` | `async (message: string, type?: 'input' \| 'confirm') => Promise<string \| boolean>` | 交互问答：input/confirm；inquirer v14 ESM-only，`await import('inquirer')` 动态导入 | inquirer（动态导入） |

依赖来源：`boxen ^8.0.1 / chalk ^6.0.0 / figlet ^1.11.4 / inquirer ^14.0.2 / log-symbols ^7.0.1 / ora ^9.4.1`，全部 MIT、registry.npmjs.org（CR-017 已评审）。

## 二、职责边界（安全约束）

- 只做终端展示：不承载业务逻辑、不打印 Key、不外发数据（安全红线）。
- 本项目 tsconfig 产物为 CJS，Node 24 原生 `require(esm)` 桥接静态导入；仅 inquirer 按 KeySpecs 走动态导入。
- `showBanner` 在持续对话模式与全局命令入口**二选一**接入（对话模式启动时一次，避免每轮刷屏）。

## 三、接入点

| 接入位置 | 调用 | 说明 |
| :--- | :--- | :--- |
| `src/cli.ts` main() → runDialog() | `showBanner(readCurrentVersion())` | 持续对话模式启动一次 |
| `src/cli.ts` runStatus() | `showStatusCard('📊 系统状态', {...})` | `thatperson status` 全局指令 |
| `src/cli.ts` 各处 | `logger.info/success/warn/error` | 已保存快照、跳过更新、未知命令、读写失败等 |
| `src/cli.ts` createInternalCommands() | `logger.success('/save')`、`logger.error('/save 失败')` | 内部指令反馈 |
| （预留）长时间操作 | `startSpinner(text)` | ora 句柄供耗时任务（当前未强制接入） |
| （预留）交互配置 | `ask(message, type)` | inquirer 问答（当前未强制接入，供后续初始化向导） |

## 四、status 卡片真实数据来源（S-10，禁止占位）

| 卡片字段 | 数据来源 | 实现 |
| :--- | :--- | :--- |
| 版本 | `package.json` version | `readCurrentVersion()`（update-check.ts，读取失败回退 0.0.0） |
| 模型 | `loadConfig().model` | config.json（默认 `DEFAULT_MODEL='deepseek-v4-flash'`） |
| 记忆条目 | `store.load()` + 归档文件统计 | profile 非空段数 + `sumArchiveEntries`（SECTION_FILES 各文件 countArchiveEntries 求和）+ `recentSessions.length` |
| 技能数量 | `listSkills(projectSkillsDirs)` | skill.ts 扫描（用户级优先 + 包内出厂 skills/，过滤 disabledSkills） |
| Token 预算 | `SYSTEM_TOKEN_BUDGET` | chat.ts 常量（6000 / 轮） |
| 工作目录 | `process.cwd()` | 运行时目录 |
| 全局目录 | `thatPersonHome()` | config.ts（THATPERSON_HOME 重定向 > ~/.thatperson） |

**示例输出（真实采样）**：

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

## 五、回归与验收

- `thatperson status` 字段与实现联动：技能数随 `skills disable/enable` 变化；记忆条目随归档写入变化（非静态占位）。
- 全量回归：`npm.cmd test` 111/111 通过（含 tests/cli.test.ts 对 status 卡片字段无占位示例、Token 预算联动 SYSTEM_TOKEN_BUDGET 的断言）。
- 离线可验证：`--mock` 模式不读 Key、不发网络；status/skills/config 等全局指令均可离线运行。

## 六、已知观察（待确认，非缺陷）

- `thatperson memory stats` 会输出两行 session_logs（`session_logs: 0 条` 来自 SECTION_FILES 空映射循环 + `session_logs: 2 篇` 来自独立统计）——轻微展示重复，是否合并待 BUCISHUI/QA 确认。
- `startSpinner` / `ask` 当前为预留接口（尚无强制调用点），待初始化向导或长任务接入后启用。

---

> 标签：`#CLI界面` `#项目/ThatPerson`
