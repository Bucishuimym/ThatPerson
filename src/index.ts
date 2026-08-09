import path from 'node:path';
import { createMemoryStore } from './memory/store';
import { extractArchives, buildSessionSummary } from './parser/archive';
import type { LoadedMemories, ArchiveEntry, MemorySection } from './memory/types';

// 加载项目根目录 .env（不覆盖已存在的系统环境变量）
try {
  process.loadEnvFile(path.resolve(__dirname, '..', '..', '.env'));
} catch {
  // 项目下没有 .env 时忽略，改用系统环境变量
}

const API_KEY = process.env.AAGENTDS_API_KEY;
const BASE_URL = 'https://api.deepseek.com';
const MODEL = 'deepseek-chat';

// --mock：离线演示模式，不调用真实 API（保护 Key 不被随意消耗）
const isMock = process.argv.includes('--mock');
const prompt = process.argv.slice(2).filter((a) => a !== '--mock')[0] ?? '今天过得怎么样？';

if (!isMock && !API_KEY) {
  console.error('错误：未找到 AAGENTDS_API_KEY，请检查项目根目录的 .env 文件');
  process.exit(1);
}

/** 按提示词 2.2/4.x 将已加载记忆组织为 system 上下文 */
function buildSystemPrompt(memories: LoadedMemories): string {
  const parts: string[] = [
    '你是「ThatGirl」——一位温暖、细腻、善于倾听的个人 AI 伴侣。',
    '沟通风格温和真诚，像认识很久的挚友；不主动打探隐私，尊重用户的沉默。',
    '回复时自然地融入 1-2 个记忆点，但不要机械罗列记忆内容。',
  ];
  const profileText = Object.values(memories.profile).map((s) => s.trim()).filter(Boolean).join('\n');
  if (profileText) parts.push(`<用户画像>\n${profileText}\n</用户画像>`);
  if (memories.importantDates?.trim()) parts.push(`<重要日期>\n${memories.importantDates}\n</重要日期>`);
  if (memories.patterns?.trim()) parts.push(`<长期模式>\n${memories.patterns}\n</长期模式>`);
  if (memories.recentSessions.length) {
    parts.push(`<近期对话>\n${memories.recentSessions.join('\n---\n')}\n</近期对话>`);
  }
  return parts.join('\n\n');
}

async function chat(userPrompt: string, memories: LoadedMemories): Promise<string> {
  if (isMock) {
    return `（离线演示，未调用 API）我在听～关于「${userPrompt}」，感觉你今天状态不错，可以多和我聊聊。`;
  }
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt(memories) },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      signal: AbortSignal.timeout(30_000),
    }),
  });
  if (!res.ok) {
    const raw = await res.text();
    const detail = raw.slice(0, 500).replace(/sk-[A-Za-z0-9]+/g, 'sk-***');
    throw new Error(`API 请求失败（HTTP ${res.status}）：${detail}`);
  }
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? '';
}

/** 归档类型 -> 记忆目录（提示词 3.1 主动归档映射） */
function sectionOf(entry: ArchiveEntry): MemorySection {
  switch (entry.type) {
    case '偏好':
    case '身份':
      return 'profile';
    case '经历':
      return 'experiences';
    case '日期':
      return 'timeline';
    case '模式':
      return 'insights';
  }
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function main(): Promise<void> {
  const store = createMemoryStore();
  store.ensureStructure();
  const memories = await store.load();

  const profileCount = Object.values(memories.profile).filter((s) => s.trim()).length;
  console.log(`[ThatGirl] 记忆已加载：画像 ${profileCount}/3 · 重要日期 ${memories.importantDates ? '有' : '无'} · 最近会话 ${memories.recentSessions.length} 天`);
  if (isMock) console.log('[ThatGirl] 离线模式（--mock），不会调用 API');

  console.log(`提问：${prompt}`);
  console.log('---');
  const reply = await chat(prompt, memories);
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
