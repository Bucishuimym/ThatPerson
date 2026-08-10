#!/usr/bin/env node
/**
 * 持续对话 CLI（第三版提示词 · 一/五/六/七）
 * 用法：npm run chat（或 --mock 离线演示）；全局安装后任意目录输入 thatperson
 * 新增：/skill 斜杠命令与自动触发、跨轮模式检测、summary 二次折叠、
 *       ~/.thatperson 全局目录初始化（ensureConfigDir）。
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { chat, loadEnv, sectionOf, today, foldSummary, type ChatMessage } from './chat';
import { loadPresent } from './present';
import { createMemoryStore } from './memory/store';
import { extractArchives, buildSessionSummary, detectCrossTurnPatterns } from './parser/archive';
import { ensureConfigDir, loadConfig } from './config';
import { listSkills, matchSkill } from './skill';

const EXIT_CMDS = new Set(['exit', 'quit', '退出', '再见']);
/** 超过该条数后开始折叠最早轮次（保留最近 4 轮 = 8 条） */
const HISTORY_LIMIT = 8;
/** 检索源：最近 2 轮用户话（3b） */
const RECENT_WINDOW = 2;
/** 跨轮模式观察窗口：最近 6 轮（3c） */
const PATTERN_WINDOW = 6;

async function main(): Promise<void> {
  loadEnv();
  const isMock = process.argv.includes('--mock');
  const { home } = ensureConfigDir();
  const config = loadConfig();
  const store = createMemoryStore();
  store.ensureStructure();
  const present = loadPresent();
  const projectSkillsDirs = [path.resolve(process.cwd(), '.claude', 'skills')];

  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log('[ThatPerson] 持续对话模式已开启' + (isMock ? '（离线演示，不调用 API）' : ''));
  console.log(`[ThatPerson] 全局目录：${home} ｜ 默认模型：${config.model}`);
  const skills = listSkills(projectSkillsDirs);
  if (skills.length) {
    console.log(`[ThatPerson] 已发现 Skill：${skills.map((s) => s.name).join(' / ')}（输入 /<名称> 直接调用）`);
  }
  console.log('[ThatPerson] 输入 exit / quit / 退出 / 再见 结束对话\n');

  let history: ChatMessage[] = [];
  let summary = '';
  const recentUserTexts: string[] = [];

  while (true) {
    let line: string;
    try {
      line = ((await rl.question('你：')) ?? '').trim();
    } catch {
      break; // 输入流关闭（如管道 EOF）
    }
    if (!line) continue;
    if (EXIT_CMDS.has(line)) break;

    // Skill 触发（第 5 项）：/ 前缀优先匹配 Skill 名称
    if (line.startsWith('/')) {
      const match = matchSkill(line, projectSkillsDirs);
      if (match) {
        const { skill, via } = match;
        console.log(`[ThatPerson] 调用 Skill「${skill.name}」（${via === 'slash' ? '斜杠命令' : '自动触发'}）`);
        console.log(`--- ${skill.name} · SKILL.md（渐进式加载） ---`);
        console.log(skill.content.slice(0, 3000));
        console.log('---');
        recentUserTexts.push(line);
        if (recentUserTexts.length > PATTERN_WINDOW) recentUserTexts.shift();
        continue;
      }
      console.log(`[ThatPerson] 未找到 Skill「${line.slice(1)}」。可用：${skills.map((s) => s.name).join(' / ') || '无'}`);
      continue;
    }

    const memories = await store.load();
    try {
      const reply = await chat(line, memories, {
        presentText: present,
        history,
        summary,
        recentUserTexts: recentUserTexts.slice(-RECENT_WINDOW),
        isMock,
      });
      console.log(`ThatPerson：${reply}\n`);

      history.push({ role: 'user', content: line }, { role: 'assistant', content: reply });
      // 分层摘要：超出窗口时，把最早一轮折叠进摘要；summary 有上限（3d 二次折叠）
      while (history.length > HISTORY_LIMIT) {
        const [u, a] = history.splice(0, 2);
        summary = `${summary ? summary + '\n' : ''}用户说「${u.content}」，你回应「${a.content}」`;
        summary = foldSummary(summary);
      }
      recentUserTexts.push(line);
      if (recentUserTexts.length > PATTERN_WINDOW) recentUserTexts.shift();

      const archives = extractArchives(line, reply);
      // 跨轮模式（3c）：窗口内同主题跨 ≥2 轮才记录，单条消息不产模式
      const crossPatterns = detectCrossTurnPatterns(recentUserTexts);
      for (const entry of crossPatterns) {
        store.appendArchive(sectionOf(entry), entry);
      }
      for (const entry of archives) {
        store.appendArchive(sectionOf(entry), entry);
      }
      store.appendSessionLog(buildSessionSummary(today(), line, reply, [...archives, ...crossPatterns]));
      const archivedCount = archives.length + crossPatterns.length;
      if (archivedCount) console.log(`[ThatPerson] 已归档 ${archivedCount} 条记忆\n`);
    } catch (err) {
      console.error(`[ThatPerson] 出错：${err instanceof Error ? err.message : err}\n`);
    }
  }

  rl.close();
  console.log('[ThatPerson] 已退出，期待下次聊天～');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});