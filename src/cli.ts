/**
 * 持续对话 CLI（第二版提示词 · 一）
 * 用法：npm run chat（或 --mock 离线演示）
 * 本质：while 循环 —— 读输入 → 调用引擎 → 输出 → 归档 → 等下一轮
 * 上下文工程：最近 4 轮保留完整，更早轮次折叠为结构化摘要（分层摘要策略）。
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chat, loadEnv, sectionOf, today, type ChatMessage } from './chat';
import { loadPresent } from './present';
import { createMemoryStore } from './memory/store';
import { extractArchives, buildSessionSummary } from './parser/archive';

const EXIT_CMDS = new Set(['exit', 'quit', '退出', '再见']);
/** 超过该条数后开始折叠最早轮次（保留最近 4 轮 = 8 条） */
const HISTORY_LIMIT = 8;

async function main(): Promise<void> {
  loadEnv();
  const isMock = process.argv.includes('--mock');
  const store = createMemoryStore();
  store.ensureStructure();
  const present = loadPresent();

  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log('[ThatPerson] 持续对话模式已开启' + (isMock ? '（离线演示，不调用 API）' : ''));
  console.log('[ThatPerson] 输入 exit / quit / 退出 / 再见 结束对话\n');

  let history: ChatMessage[] = [];
  let summary = '';

  while (true) {
    let line: string;
    try {
      line = ((await rl.question('你：')) ?? '').trim();
    } catch {
      break; // 输入流关闭（如管道 EOF）
    }
    if (!line) continue;
    if (EXIT_CMDS.has(line)) break;

    const memories = await store.load();
    try {
      const reply = await chat(line, memories, { presentText: present, history, summary, isMock });
      console.log(`ThatPerson：${reply}\n`);

      history.push({ role: 'user', content: line }, { role: 'assistant', content: reply });
      // 分层摘要：超出窗口时，把最早一轮折叠进摘要
      while (history.length > HISTORY_LIMIT) {
        const [u, a] = history.splice(0, 2);
        summary = `${summary ? summary + '\n' : ''}用户说「${u.content}」，你回应「${a.content}」`;
      }

      const archives = extractArchives(line, reply);
      for (const entry of archives) {
        store.appendArchive(sectionOf(entry), entry);
      }
      store.appendSessionLog(buildSessionSummary(today(), line, reply, archives));
      if (archives.length) console.log(`[ThatPerson] 已归档 ${archives.length} 条记忆\n`);
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