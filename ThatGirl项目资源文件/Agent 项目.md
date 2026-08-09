# Agent 项目

> 创建：2026-08-06
> 状态：#状态/进行中
> 代码位置：`G:\XXFS\Pycharm\ThatGirl\Agent.py`

## 项目目标

做一款**无限接近人**的 Agent——不只是工具，而是一个"像真正的朋友一样陪伴在身边的人"：

- 一开始像一张白纸；
- 可以向它投喂聊天记录、投喂"你想让它成为的样子"；
- 给它设定、给它起名字；
- 让它能记住你、理解你、陪伴你（API=大脑、skill=手、Markdown=记忆）。

**商业动机**：单身经济正在爆发（2026 年中国单身人口约 2.5 亿，市场 5 万亿至 13 万亿，占 GDP 近 10%）。人们愿为宠物付费、为情绪付费——为什么不愿为一个能长期陪伴自己的 Agent 付费？这是"情感陪伴"的空白市场。

## 当前进度（2026-08-06）

- ✅ **API 调用已跑通**：用 DeepSeek API 写了第一个 Python 脚本，真实收到了 AI 回复 "Hello! How can I help you today?" —— 大脑（API）已连通。
- ✅ **亲手写了一个 skill**：`warehouse-management`（把知识库分类指引归整成 skill），亲眼看到 agent 是如何调用 skill 的——手（skill）已验证可行。
- ✅ **理解了记忆机制**：OpenClaw 用 `.openclaw` 下的 Markdown 存用户数据——记忆（Markdown）的雏形。

**核心理解**：API=大脑，skill=四肢（让 AI 多一只手，把眼界从单个文件放到整个仓库全局），Markdown=记忆。三者拼起来，就是一个最简 Agent。

## 教训 / 洞察

- 把"调 API 的方式"从纯 Prompt 进化成"做成 skill"，白痴指数一下就下降了——不是问 AI 该做什么，而是给 AI 一只手让它自己扫整个仓库。
- 今天写的 `Agent.py` 还是最单薄的一步（只验证了对话），离"像人"还很远，但起点已经落地。

## ⚠️ API Key 安全隐患（待办）

`Agent.py` 里 API key 是**明文写死**的（`api_key="sk-***"`）。该文件将来若推上 GitHub 会直接泄漏。应立即改为从环境变量读取：

```python
import os
client = OpenAI(
    api_key=os.environ.get('DEEPSEEK_API_KEY'),
    base_url="https://api.deepseek.com"
)
```

> **AI 评价**：这个项目你已经把"想"落成了"做"——从调通 API 到亲眼验证 skill 调用机制，跨出了从纯思考到动手的关键一步。你提出的 API=大脑 / skill=手 / Markdown=记忆 是一个直觉很准的 Agent 架构心智模型。改进建议：1) 先解决 API key 明文泄漏（第一优先级，安全问题）；2) 下一步不必急着做"像人"，先把记忆（Markdown）和手（skill 自动调用）拼起来，做一个能记住你的最小闭环；3) 写死 key 这段教训，值得单独记进 `2-领域` 或知识参考，避免重复踩坑。
>
> #主题/人工智能 #类型/项目 #状态/进行中 #评价/良好
