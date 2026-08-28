/**
 * 工具层共享契约（第 5 期批次二 · KS-16；第 6 期批次二 · KS-34/KS-35 安全等级与结构化拒绝）
 *
 * 工具层全部使用 node:fs / node:path / node:child_process 原生实现，
 * 零第三方依赖（ADR-4：白名单 + 参数校验 + 目录白名单替代通用代码沙箱）。
 * 本文件只定义类型，不包含任何逻辑与内容。
 */

/** 工具权限门：read=只读 / write=写盘 / danger=危险操作（需环境变量 + 用户确认双门控） */
export type ToolPolicy = 'read' | 'write' | 'danger';

/** 风险分级（第 6 期批次二 · KS-34）：L0 只读 / L1 写自身 home+present / L2 写白名单外部 / L3 命令执行 */
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3';

/** 结构化拒绝错误码（第 6 期批次二 · KS-35） */
export type ToolErrorCode =
  | 'danger-disabled'
  | 'path-denied'
  | 'param-invalid'
  | 'conflict'
  | 'unknown-tool'
  | 'not-found'
  | 'io-error'
  | 'redline-denied'
  | 'other';

/** 参数声明（轻量 JSON Schema 子集；enum 仅用于 string 类型） */
export interface ToolParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  description?: string;
  enum?: string[];
}

/** 工具执行上下文：路径白名单由此下发（loop 组装，builtin 校验） */
export interface ToolContext {
  cwd: string;
  home: string;
  allowedRoots: string[];
}

/** 工具定义：name 唯一（snake_case），description 一句话 + 能力边界，policy 权限门，riskLevel 风险等级 */
export interface ToolDef {
  name: string;
  description: string;
  params: ToolParam[];
  policy: ToolPolicy;
  /** 风险等级（KS-34）；测试注册的自定义工具可省略，executor 按 policy 兜底 */
  riskLevel?: RiskLevel;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => ToolHandlerResult | Promise<ToolHandlerResult>;
}

/** 工具执行结果：成功返回 content（由 executor 统一截断），失败返回结构化失败信封 */
export type ToolResult = { ok: true; content: string } | ToolFailure;

/** 失败信封（KS-35）：error 保留既有字符串（向后兼容），另附 code/riskLevel/reason/unlockHint */
export interface ToolFailure {
  ok: false;
  error: string;
  code: ToolErrorCode;
  riskLevel: RiskLevel;
  /** 一句人话原因（回灌给模型） */
  reason: string;
  /** 解锁动作指引（红线项为空串，不给解锁路径） */
  unlockHint: string;
}

/** handler 内部返回（简式失败由 executor 统一升级为 ToolFailure 信封） */
export type ToolHandlerResult = { ok: true; content: string } | { ok: false; error: string };
