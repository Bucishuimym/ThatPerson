/**
 * 记忆系统共享契约（依据《关于ThatPerson-Agent项目第一版提示词》v3.0）
 * 提示词 2.1 记忆存储结构 / 4.2 归档格式 / 4.3 每日摘要格式
 * 本文件为团队并行开发的统一接口，各模块不得修改，只能实现/调用。
 */

/** 记忆目录分类（提示词 2.1） */
export type MemorySection =
  | 'profile' // 身份画像：identity/preferences/traits
  | 'timeline' // 人生节点：milestones/important_dates
  | 'experiences' // 经历日志：journal
  | 'insights' // 模式洞察：patterns
  | 'session_logs'; // 每日对话摘要：YYYY-MM-DD.md

/** 归档类型（提示词 4.2） */
export type ArchiveType = '偏好' | '经历' | '日期' | '身份' | '模式';

/** 置信度（提示词 附录：高=明确陈述，中=多次推断，低=单次暗示） */
export type Confidence = '高' | '中' | '低';

/** 记忆目录文件名映射（提示词 2.1） */
export const SECTION_FILES: Record<MemorySection, readonly string[]> = {
  profile: ['identity.md', 'preferences.md', 'traits.md'],
  timeline: ['milestones.md', 'important_dates.md'],
  experiences: ['journal.md'],
  insights: ['patterns.md'],
  session_logs: [],
};

/** 归档条目（提示词 4.2 标准化格式） */
export interface ArchiveEntry {
  /** 归档类型：偏好 / 经历 / 日期 / 身份 / 模式 */
  type: ArchiveType;
  /** 原始对话片段（用户原话） */
  dialog: string;
  /** 提炼信息（1-2 句话概括） */
  insight: string;
  /** 置信度：高 / 中 / 低 */
  confidence: Confidence;
  /** 关联标签，如 #饮食偏好 #咖啡 */
  tags: string[];
  /** 与旧记忆冲突时标注（提示词 4.2 archiving_rules） */
  conflict?: string;
}

/** 每日对话摘要（提示词 4.3） */
export interface SessionSummary {
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 核心话题 */
  topics: string[];
  /** 情绪基调：轻松 / 焦虑 / 兴奋 / 低落 / 平静 等 */
  mood: string;
  /** 新增记忆条目，格式：类型 | 内容 | 置信度 */
  newMemories: string[];
  /** 待跟进事项 */
  followUps: string[];
}

/** 记忆加载结果（提示词 2.2 读取流程） */
export interface LoadedMemories {
  /** 用户画像基线：文件名 -> 内容 */
  profile: Record<string, string>;
  /** 今日重要日期文件内容，无则 null */
  importantDates: string | null;
  /** 长期行为模式文件内容，无则 null */
  patterns: string | null;
  /** 最近 7 天的会话摘要内容，按日期从新到旧 */
  recentSessions: string[];
}

/** 记忆存储接口：实现于 src/memory/store.ts */
export interface MemoryStore {
  /** 初始化 history/ 目录结构（提示词 2.1；缺失目录/文件才创建，不创建空文件） */
  ensureStructure(): void;
  /** 按提示词 2.2 顺序加载记忆 */
  load(): Promise<LoadedMemories>;
  /** 追加一条归档到对应 section 文件末尾（提示词 4.2 格式，不覆盖旧内容） */
  appendArchive(section: MemorySection, entry: ArchiveEntry): void;
  /** 追加当日会话摘要（提示词 4.3 格式） */
  appendSessionLog(summary: SessionSummary): void;
}
