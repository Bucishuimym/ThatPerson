/**
 * Skill 调用模块（第三版提示词 · 五）
 * 第 5 期批次一（KS-12）：级联 = 主目录 ~/.thatperson/skills/ → 随身目录 <cwd>/.thatperson/skills/ → 包内出厂 skills/；
 * 同名靠前优先（主目录 > 随身目录 > 出厂/调用方传入）。
 * 触发方式：/skill 名称（cli 中以 / 开头优先匹配）；trigger_keywords 自动触发。
 * 渐进式加载：发现 → 激活 → 执行（仅在触发时读取完整 SKILL.md，节省 token）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { listDisabledSkills, localThatPersonDir, thatPersonHome } from './config';

export interface SkillInfo {
  name: string;
  description: string;
  triggerKeywords: string[];
  /** SKILL.md frontmatter 声明的工具名列表（第 5 期 KS-21：技能 = 工具组合说明书） */
  tools: string[];
  dir: string;
  skillPath: string;
  content: string;
}

export type SkillMatch = { skill: SkillInfo; via: 'slash' | 'auto' };

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/** 出厂技能库：包内 skills/ 目录（编译产物位于 dist/src/，向上两级定位包根） */
const PACKAGE_SKILLS_DIR = path.resolve(__dirname, '..', '..', 'skills');

/** 默认技能扫描目录：出厂技能库（包内 skills/），用户级 ~/.thatperson/skills/ 仍优先 */
function defaultSkillDirs(): string[] {
  return [PACKAGE_SKILLS_DIR];
}

/** 解析 SKILL.md frontmatter（name/description/trigger_keywords/tools；支持多行 YAML 列表） */
function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  trigger_keywords?: string;
  tools?: string;
} {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return {};
  const meta: Record<string, string> = {};
  let listKey = '';
  for (const line of m[1].split('\n')) {
    // 多行 YAML 列表续行（如 trigger_keywords: 下的 "  - 关键词"）：收集为逗号分隔，供 parseTriggerKeywords 消费
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const value = item[1].trim().replace(/^['"]|['"]$/g, '').trim();
      if (value) meta[listKey] = meta[listKey] ? `${meta[listKey]},${value}` : value;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) {
      listKey = '';
      continue;
    }
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '').trim();
    if (key) {
      meta[key] = val;
      listKey = val === '' ? key : '';
    }
  }
  return meta;
}


/** 解析 trigger_keywords（支持数组 JSON 或逗号分隔） */
function parseTriggerKeywords(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((x) => String(x)).filter((x) => x.length > 0);
    }
  } catch {
    // 不是 JSON，按逗号/顿号分隔
  }
  return trimmed
    .split(/[,，、\s]+/)
    .map((x) => x.replace(/^['"[\]]|['"[\]]$/g, '').trim())
    .filter((x) => x.length > 0);
}

/** 读取单个 SKILL.md 为 SkillInfo（frontmatter 缺失时以目录名兜底） */
function readSkill(skillPath: string): SkillInfo | null {
  let content: string;
  try {
    content = fs.readFileSync(skillPath, 'utf8');
  } catch {
    return null;
  }
  const meta = parseFrontmatter(content);
  const name = (meta.name || path.basename(path.dirname(skillPath))).toLowerCase();
  return {
    name,
    description: meta.description || '',
    triggerKeywords: parseTriggerKeywords(meta.trigger_keywords),
    tools: parseTriggerKeywords(meta.tools),
    dir: path.dirname(skillPath),
    skillPath,
    content,
  };
}

/** 主目录 Skill 目录（默认 ~/.thatperson/skills/） */
function userSkillDirs(): string[] {
  return [path.join(thatPersonHome(), 'skills')];
}

/** 随身目录 Skill 目录（<cwd>/.thatperson/skills/；随 localThatPersonDir 判定） */
function portableSkillDirs(): string[] {
  const local = localThatPersonDir();
  if (!local) return [];
  return [path.join(local, 'skills')];
}

/** 扫描所有 Skill（主目录优先；同名去重） */
export function listSkills(projectSkillsDirs: string[] = defaultSkillDirs()): SkillInfo[] {
  const dirs = [...userSkillDirs(), ...portableSkillDirs(), ...projectSkillsDirs];
  // 第 4 期（D-3b）：过滤 config.json 中 disabledSkills 已禁用的技能（skills disable/enable 持久化）
  const disabled = new Set(listDisabledSkills());
  const seen = new Set<string>();
  const out: SkillInfo[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const info = readSkill(skillPath);
      if (info && !disabled.has(info.name) && !seen.has(info.name)) {
        seen.add(info.name);
        out.push(info);
      }
    }
  }
  return out;
}

/** 按名称加载 Skill（主目录优先） */
export function loadSkill(name: string, projectSkillsDirs: string[] = defaultSkillDirs()): SkillInfo | null {
  const dirs = [...userSkillDirs(), ...portableSkillDirs(), ...projectSkillsDirs];
  const target = name.toLowerCase().replace(/^\/+/, '');
  // 路径白名单（安全红线 4）：拒绝穿越与路径分隔符，禁止用户输入拼接文件系统路径
  if (!target || target.includes('..') || /[\\/]/.test(target)) return null;
  for (const dir of dirs) {
    const skillPath = path.join(dir, target, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const info = readSkill(skillPath);
      if (info) return info;
    }
  }
  return null;
}

/**
 * 匹配 Skill：
 * - slash：输入以 / 开头 → 精确匹配名称，其次前缀匹配（≥2 字符）。
 * - auto：trigger_keywords 命中（description 自动触发保留：description 首词段命中时也激活）。
 */
export function matchSkill(input: string, projectSkillsDirs: string[] = defaultSkillDirs()): SkillMatch | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const skills = listSkills(projectSkillsDirs);
  if (skills.length === 0) return null;
  if (trimmed.startsWith('/')) {
    const name = trimmed.slice(1).trim().toLowerCase();
    if (!name) return null;
    const exact = skills.find((s) => s.name.toLowerCase() === name);
    if (exact) return { skill: exact, via: 'slash' };
    const prefix = skills
      .filter((s) => s.name.toLowerCase().startsWith(name) && name.length >= 2)
      .sort((a, b) => a.name.length - b.name.length)[0];
    if (prefix) return { skill: prefix, via: 'slash' };
    return null;
  }
  // auto：trigger_keywords 命中优先；其次 description 前 12 字片段包含
  for (const s of skills) {
    if (s.triggerKeywords.some((k) => trimmed.includes(k))) {
      return { skill: s, via: 'auto' };
    }
  }
  for (const s of skills) {
    const descLead = s.description.slice(0, 12);
    if (descLead.length >= 4 && trimmed.includes(descLead)) {
      return { skill: s, via: 'auto' };
    }
  }
  return null;
}
