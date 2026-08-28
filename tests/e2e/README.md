# tests/e2e · --mock 端到端（第 6 期批次三 · 记忆主线）

四个闭环全部 `--mock` 全自动，零网络、零 API、零第三方依赖：

| 文件 | 闭环 |
| :--- | :--- |
| `session.test.ts` | 会话可恢复：save → 新 home list 可见 → load 恢复 → `runAgentLoop` 输入 history 含前情 |
| `portable.test.ts` | 记忆可带走：export → 新 home import → `memory search` 命中；导出包无 Key 明文 |
| `tools.test.ts` | 插件化跑通（`move_file` 经 loop 真实执行）+ 连续失败 3 次不再「我做不到」 |

## 运行方式

```bash
# 先编译测试产物（tsconfig.test.json 的 include 覆盖 tests/**，含 e2e 子目录）
node node_modules/typescript/bin/tsc --noEmit && node node_modules/typescript/bin/tsc -p tsconfig.test.json
# 再单独跑 e2e（glob 指向子目录）
node --test dist-test/tests/e2e/*.test.js
```

> 注意：`npm.cmd test` 的全量 glob 是 `dist-test/tests/*.test.js`，不含子目录，因此 e2e 不并入全量。
> 核心闭环已由 `tests/session.test.ts`、`tests/portable.test.ts`、`tests/tools.test.ts`
> 的单元 + 集成用例覆盖（纳入全量 213+），本目录是对应 `--mock` 端到端演示。
