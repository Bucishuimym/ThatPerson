/**
 * 工具注册表（第 5 期批次二 · KS-17）
 *
 * 白名单式注册：只有 registerTool/registerBuiltins 显式登记的工具才能被 executor 执行；
 * 未注册名称一律 unknown-tool。同名重复注册覆盖并告警（技能动态注册/卸载场景）。
 */
import type { ToolDef } from './types';

/** 全局注册表：name -> ToolDef */
const registry = new Map<string, ToolDef>();

/** 注册工具（同名重复注册覆盖旧定义，并 console.warn 告警） */
export function registerTool(def: ToolDef): void {
  if (registry.has(def.name)) {
    console.warn(`[ThatPerson] 工具「${def.name}」重复注册，已用新定义覆盖`);
  }
  registry.set(def.name, def);
}

/** 注销工具（技能动态注册/卸载用；不存在的名称静默忽略） */
export function unregisterTool(name: string): void {
  registry.delete(name);
}

/** 按名称取工具定义 */
export function getTool(name: string): ToolDef | undefined {
  return registry.get(name);
}

/** 是否已注册 */
export function isRegistered(name: string): boolean {
  return registry.has(name);
}

/** 当前全部已注册工具（保持注册顺序） */
export function listTools(): ToolDef[] {
  return Array.from(registry.values());
}

/**
 * 静态生成精简工具清单描述（供 <工具清单> 注入 System Prompt 使用）。
 * 每行格式：`- name(参数名:类型[, 必填]): 描述`
 * 只含参数名/类型/描述元数据，不含任何对话或记忆内容（SEC-10：静态不可注入）。
 */
export function buildToolSpecs(tools: ToolDef[]): string {
  return tools
    .map((def) => {
      const params = def.params
        .map((p) => `${p.name}:${p.type}${p.required ? ',必填' : ''}`)
        .join(', ');
      return `- ${def.name}(${params}): ${def.description}`;
    })
    .join('\n');
}
