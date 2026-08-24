/**
 * 工具层共享契约（第 5 期批次二 · KS-16）
 *
 * 工具层全部使用 node:fs / node:path / node:child_process 原生实现，
 * 零第三方依赖（ADR-4：白名单 + 参数校验 + 目录白名单替代通用代码沙箱）。
 * 本文件只定义类型，不包含任何逻辑与内容。
 */

/** 工具权限门：read=只读 / write=写盘 / danger=危险操作（需环境变量 + 用户确认双门控） */
export type ToolPolicy = 'read' | 'write' | 'danger';

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

/** 工具定义：name 唯一（snake_case），description 一句话 + 能力边界，policy 权限门 */
export interface ToolDef {
  name: string;
  description: string;
  params: ToolParam[];
  policy: ToolPolicy;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
}

/** 工具执行结果：成功返回 content（由 executor 统一截断），失败返回 error */
export type ToolResult = { ok: true; content: string } | { ok: false; error: string };
