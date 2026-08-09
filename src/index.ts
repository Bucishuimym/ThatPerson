/**
 * ThatGirl 单次命令入口（第二版提示词 · 一：与 npm run chat 共存，不破坏原有功能）
 * 用法：npm run dev <问题> | npm run mock <问题>
 */
import { chat, loadEnv, sectionOf, today } from './chat';
import { loadPresent } from './present';
import { createMemoryStore } from './memory/store';
import { extractArchives, buildSessionSummary } from './parser/archive';

loadEnv();

// --mock：离线演示模式，不调用真实 API（保护 Key 不被随意消耗）
const isMock = process.argv.includes('--mock');
const prompt = process.argv.slice(2).filter((a) => a !== '--mock')[0] ?? '今天过得怎么样？';

async function main(): Promise<void> {
  const store = createMemoryStore();
  store.ensureStructure();
  const memories = await store.load();
  const present = loadPresent();

  const profileCount = Object.values(memories.profile).filter((s) => s.trim()).length;
  console.log(`[ThatGirl] 记忆已加载：画像 ${profileCount}/3 · 重要日期 ${memories.importantDates ? '有' : '无'} · 最近会话 ${memories.recentSessions.length} 天`);
  if (isMock) console.log('[ThatGirl] 离线模式（--mock），不会调用 API');

  console.log(`提问：${prompt}`);
  console.log('---');
  const reply = await chat(prompt, memories, { presentText: present, isMock });
  console.log(`回答：${reply}`);
  console.log('---');

  // 对话结束后主动归档 + 生成当日摘要（提示词 3.1 / 4.2 / 4.3）
  const archives = extractArchives(prompt, reply);
  for (const entry of archives) {
    store.appendArchive(sectionOf(entry), entry);
  }
  store.appendSessionLog(buildSessionSummary(today(), prompt, reply, archives));

  console.log(`[ThatGirl] 已归档 ${archives.length} 条记忆，今日摘要已写入 history/session_logs/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});