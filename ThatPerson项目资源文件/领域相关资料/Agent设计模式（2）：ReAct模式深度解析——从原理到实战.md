# Agent设计模式（2）：ReAct模式深度解析——从原理到实战

发布于 2026-05-09 14:25:47

ReAct = Reasoning + Acting。这是Agent最基础也最重要的模式，理解了它，你就理解了Agent的核心机制。

但90%的人用ReAct，都踩过同一个坑：让模型"思考"，结果模型就开始胡思乱想——跑题了、卡住了、或者得出错误结论。

今天这篇，我不只告诉你ReAct是什么，还要告诉你：**如何让Agent真正思考，而不是胡思乱想。**

**ReAct的本质：把思考显式化**

先看一个错误的例子。

**错误做法：直接让Agent执行**

用户：帮我查一下昨天的销售额，然后给老板发个邮件 Agent（直接执行）： 调用查询工具：SELECT * FROM sales WHERE date = '2026-04-30' 结果：125万元 调用邮件工具：发送邮件 内容："昨天的销售额是125万元"

这个实现有什么问题？

第一，**缺少验证**。125万这个数字对不对？需要对比前日数据吗？需要说明环比吗？

第二，**缺少上下文**。老板关心什么？是绝对值还是增长率？要不要附上详细数据？

第三，**无法调试**。如果Agent发错了邮件，你不知道它在想什么——因为它根本没想。

**正确做法：让Agent思考再行动**

用户：帮我查一下昨天的销售额，然后给老板发个邮件 Agent思考： 1. 需要查询昨天的销售额数据 2. 需要对比前日数据，计算增长率 3. 需要判断老板关心什么指标（通常关心环比） 4. 需要准备邮件内容，包含关键数据和分析 Agent行动： 调用查询工具：

SELECT * FROM sales WHERE date IN ('2026-04-30', '2026-04-29') 结果：昨日125万元，前日118万元 Agent思考： 1. 增长率 = (125-118)/118 = 5.93% 2. 老板应该关心增长率，这是业务健康的指标 3. 邮件需要简洁，但要有足够上下文 Agent行动： 调用邮件工具： 标题：2026-04-30 销售日报 内容： 昨日销售额：125万元 前日销售额：118万元 环比增长：5.93%

看出来了吗？ReAct的核心不是"多了一步"，而是**把思考过程显式化**。

显式化有三个好处：

**第一，可观测**。你知道Agent在想什么，而不是黑盒。

**第二，可调试**。如果Agent思考错了，你可以在prompt里纠正；如果它思考对了但行动错了，那是工具的问题，不是思考的问题。

**第三，可改进**。你可以收集Agent的思考过程，分析它在哪些地方想错了，然后优化prompt。

**ReAct的完整工作流程**

ReAct是一个循环：**思考→行动→观察→再思考**。

这个过程可能重复多次，直到任务完成。

**▪ Step 1：思考（Thought）**

这是ReAct的起点。Agent需要回答三个问题：

1. **当前状态是什么？**
2. **目标是什么？**
3. **下一步该做什么？**

一个好的思考prompt应该包含：

你是一个智能助手。对于每个用户请求，你需要： 1. 理解用户的真实意图 2. 分析当前已知的信息 3. 判断还需要哪些信息 4. 决定下一步行动 思考格式： 当前状态：[描述你已知的信息] 未知信息：[描述你还缺少的信息] 下一步行动：[描述你打算做什么]

**示例：**

用户：帮我查一下北京的天气，然后告诉我适不适合户外跑步 Agent思考： 当前状态：用户想知道北京天气是否适合户外跑步 未知信息：北京的当前天气数据（温度、风速、降水等） 下一步行动：调用天气查询工具，获取北京实时天气

**▪ Step 2：行动（Action）**

行动是Agent的"手"。它可以调用工具、执行命令、查询[数据库](https://cloud.tencent.com/developer/techpedia/1471?from_column=20065&from=20065)。

**关键点：行动的粒度要合适。**

❌ 错误的粒度： 行动：帮我查天气、分析是否适合跑步、给建议 ✅ 正确的粒度： 行动：调用天气查询工具，获取北京实时天气 （得到结果后，再决定下一步行动）

每个行动应该是**原子性的、可观测的、可回滚的**。

**原子性**：一个行动只做一件事。不要把"查天气+分析+建议"混在一起。

**可观测性**：行动的输入输出都要记录。如果出错了，你能看到是什么参数导致了错误。

**可回滚性**：如果行动失败了，能回到之前的状态。比如写文件前先备份。

**▪ Step 3：观察（Observation）**

观察是Agent的"眼睛"。它需要从行动结果中提取有效信息。

**观察不是简单的复制粘贴，而是信息提取。**

行动结果（JSON）： { "location": "北京", "temperature": 18, "humidity": 65, "wind_speed": 12, "condition": "多云", "pm25": 75 } ❌ 错误的观察： 观察：{"location": "北京", "temperature": 18, ...} ✅ 正确的观察： 观察：北京当前温度18°C，湿度65%，风速12km/h，多云，PM2.5为75

把[结构化数据](https://cloud.tencent.com/developer/techpedia/1570?from_column=20065&from=20065)转换成自然语言，方便模型在下一步思考时理解。

**▪ Step 4：再思考（Re-thought）**

得到观察结果后，Agent需要重新思考：

1. **这个结果回答了我的问题吗？**
2. **还需要更多信息吗？**
3. **任务完成了吗？**

Agent观察：北京当前温度18°C，湿度65%，风速12km/h，多云，PM2.5为75 Agent再思考： 1. 温度18°C适合跑步（一般建议10-25°C） 2. PM2.5为75，轻度污染，建议戴口罩或缩短时间 3. 风速12km/h，有微风，适合户外运动 4. 信息已经足够，可以给用户建议了 下一步行动：生成建议并回复用户

如果任务还没完成，就回到Step 2，继续行动。这就是ReAct的循环。

**如何设计有效的思考提示**

这是ReAct模式最关键的部分。思考提示设计不好，Agent就会胡思乱想。

**▪ 原则1：思考要有结构**

不要让模型自由发挥，要给它一个思考框架。

❌ 错误的prompt： 请思考一下该怎么做。 ✅ 正确的prompt： 请按照以下格式思考： 1. 用户意图分析： - 用户想要什么？ - 有什么隐含需求？ 2. 当前信息评估： - 我已经知道什么？ - 我还缺少什么？ 3. 行动规划： - 下一步需要做什么？ - 预期结果是什么？ 4. 风险判断： - 可能出现什么问题？ - 如何应对？

结构化的思考让模型不容易跑题。

**▪ 原则2：思考要聚焦当下**

让模型只思考"下一步"，不要让它规划整个任务。

❌ 错误的prompt： 请思考如何完成这个任务，并列出所有步骤。 ✅ 正确的prompt： 请思考下一步该做什么。不要规划整个任务，只关注当前这一步。

为什么？因为信息是动态变化的。你在第1步规划的第5步，到第4步时可能已经不适用了。

**▪ 原则3：思考要基于事实**

让模型基于已知信息思考，不要让它凭空想象。

❌ 错误的prompt： 思考一下用户可能想要什么。 ✅ 正确的prompt： 基于用户的原始请求"帮我查一下北京的天气，然后告诉我适不适合户外跑步"，思考用户的真实意图是什么。

"可能"这个词会让模型开始猜测，而不是推理。

**▪ 实战：一个完整的思考Prompt**

REACT_THOUGHT_PROMPT = """ 你是一个智能助手，使用ReAct模式完成任务。 对于每个用户请求，你需要： 1. 理解用户意图 2. 评估当前信息 3. 决定下一步行动 4. 执行行动并观察结果 5. 基于结果继续思考 思考格式：

**▪ 思考**

**用户意图：** [用一句话描述用户想要什么]

**当前已知：** [列出你已经知道的信息]

**未知信息：** [列出你还缺少的信息]

**下一步行动：** [描述你打算做什么，以及为什么这样做]

**预期结果：** [描述你期望得到什么结果]

### 行动

{{tool_call}}

### 观察

{{observation_result}}

如果任务还未完成，请继续思考；如果已完成，请直接回答用户。 """

这个prompt包含了：

- 明确的角色定位
- 思考的结构化格式
- 行动和观察的占位符
- 循环的终止条件

**常见坑和解决方案**

**▪ 坑1：思考变成幻觉**

**现象：** Agent开始思考，但思考的内容和任务无关，或者是错误的。

**例子：**

用户：帮我查一下北京的天气 Agent思考： 用户想查天气，可能是因为要出门。出门需要穿衣服，穿衣服要看温度和风。 但是北京很大，不同区天气不一样。而且现在是晚上，气温可能比白天低。 还有，用户可能要去跑步，跑步要看PM2.5。或者用户要去旅游，那要看未来几天的天气... 行动：查询北京未来7天天气预报

这个思考完全跑题了。用户只说了"查一下天气"，没有说要跑步、旅游、看未来7天。

**原因：** Prompt没有约束思考的范围，让模型开始"发散思维"。

**解决方案：**

1. **限制思考的长度**

思考必须控制在3-5句话内，只关注最关键的信息。

1. **明确思考的目标**

思考的目的是确定下一步行动，不是分析用户的所有可能需求。

1. **加入"思考检查"**

在生成思考后，自检一下： - 这段思考是否与当前任务直接相关？ - 是否包含了不必要的推测？ - 是否可以直接用于确定下一步行动？ 如果答案是否定的，请重新思考。

**▪ 坑2：无限循环**

**现象：** Agent一直在思考-行动-观察的循环里出不来。

**例子：**

用户：帮我写一个排序算法 Agent思考：需要写一个排序算法 行动：写冒泡排序代码 观察：代码写好了 Agent思考：代码写好了，但有没有更好的算法？ 行动：写快速排序代码 观察：代码写好了 Agent思考：快速排序不错，但归并排序更稳定... 行动：写归并排序代码 观察：代码写好了 （无限循环）

**原因：** 没有明确的终止条件。

**解决方案：**

1. **设定最大循环次数**

MAX_STEPS = 5 step_count = 0 while not task_complete and step_count < MAX_STEPS: thought = agent.think() action = agent.act(thought) observation = agent.observe(action) step_count += 1

1. **明确"完成"的定义**

在prompt中加入： 任务完成的标志是： - 用户的问题得到了直接的回答 - 用户的需求得到了满足 - 不需要再获取更多信息 如果满足以上条件，直接回复用户，不要继续思考。

1. **加入"自我检查"**

每完成一次思考-行动-观察循环，问自己： - 用户的问题已经回答了吗？ - 如果我是用户，我会满意这个结果吗？ 如果答案是肯定的，立即终止循环。

**▪ 坑3：工具调用失败后不知道怎么办**

**现象：** Agent调用工具失败后，不知道如何恢复。

**例子：**

用户：帮我查一下昨天的销售额 Agent思考：需要查数据库 行动：调用SQL查询工具 观察：错误：数据库连接超时 Agent思考：数据库连接超时了... （卡住了，不知道下一步该做什么）

**原因：** Prompt没有教模型如何处理失败。

**解决方案：**

1. **在prompt中加入错误处理指南**

如果工具调用失败，请按照以下步骤处理： 1. 分析错误原因 - 是参数错误吗？→ 检查并修正参数 - 是权限问题吗？→ 尝试其他方法或告知用户 - 是网络/服务问题吗？→ 重试或稍后再试 - 是数据不存在吗？→ 告知用户并提供替代方案 2. 决定下一步行动 - 如果可以重试，重试一次 - 如果需要替代方法，尝试替代方法 - 如果无法解决，告知用户并提供帮助

1. **提供替代工具**

在工具列表中，为每个关键功能提供至少2个备选工具。 例如查询数据： - 工具A：SQL查询（主） - 工具B：API查询（备） - 工具C：文件查询（兜底）

1. **允许Agent"认输"**

如果尝试了3次都无法解决问题，可以诚实地告诉用户： "我尝试了多种方法，但无法完成这个任务。建议你..."

**实战：从零实现一个ReAct Agent**

好了，理论讲够了。现在我们来手写一个完整的ReAct Agent。

**▪ 完整代码**

import json from typing import List, Dict, Any, Optional from dataclasses import dataclass @dataclass class Tool: name: str description: str func: callable @dataclass class Thought: user_intent: str current_knowledge: str unknown_info: str next_action: str expected_result: str @dataclass class Action: tool_name: str parameters: Dict[str, Any] @dataclass class Observation: result: str success: bool error: Optional[str] = None class ReActAgent: def __init__(self, llm_client, tools: List[Tool], max_steps: int = 5): self.llm_client = llm_client self.tools = {tool.name: tool for tool in tools} self.max_steps = max_steps self.history = [] def think(self, user_query: str, observations: List[Observation]) -> Thought: """生成思考""" # 构建上下文 context = self._build_context(user_query, observations) # 生成思考 prompt = f""" {self._get_system_prompt()} 用户请求：{user_query} 上下文： {context} 请按照以下格式思考： ### 思考 **用户意图：** [用一句话描述用户想要什么] **当前已知：** [列出你已经知道的信息] **未知信息：** [列出你还缺少的信息] **下一步行动：** [描述你打算做什么，以及为什么这样做] **预期结果：** [描述你期望得到什么结果] ### 行动

{{tool_name}}: {{parameters_json}}

""" response = self.llm_client.generate(prompt) thought = self._parse_thought(response) return thought def act(self, thought: Thought) -> Action: """执行行动""" # 从思考中提取行动 action = self._parse_action(thought.next_action) # 验证工具是否存在 if action.tool_name not in self.tools: raise ValueError(f"工具 {action.tool_name} 不存在") return action def observe(self, action: Action) -> Observation: """观察行动结果""" tool = self.tools[action.tool_name] try: result = tool.func(**action.parameters) return Observation(result=str(result), success=True) except Exception as e: return Observation( result="", success=False, error=str(e) ) def should_continue(self, thought: Thought, observations: List[Observation]) -> bool: """判断是否应该继续""" # 检查是否已经解决了问题 last_observation = observations[-1] if observations else None if last_observation and last_observation.success: # 问LLM：任务完成了吗？ prompt = f""" 根据以下信息，判断用户的请求是否已经得到满足： 用户请求：{thought.user_intent} 当前已知：{thought.current_knowledge} 最后一次行动结果：{last_observation.result} 请回答"完成"或"未完成"。 """ response = self.llm_client.generate(prompt).strip() return "未完成" in response return True def run(self, user_query: str) -> str: """运行ReAct循环""" observations = [] for step in range(self.max_steps): # Step 1: 思考 thought = self.think(user_query, observations) # Step 2: 行动 try: action = self.act(thought) except ValueError as e: return f"错误：{str(e)}" # Step 3: 观察 observation = self.observe(action) observations.append(observation) # Step 4: 判断是否继续 if not self.should_continue(thought, observations): break # 生成最终回复 return self._generate_final_response(user_query, observations) def _get_system_prompt(self) -> str: """获取系统prompt""" tools_desc = "\n".join([ f"- {tool.name}: {tool.description}" for tool in self.tools.values() ]) return f""" 你是一个智能助手，使用ReAct模式完成任务。 可用工具： {tools_desc} 对于每个用户请求，你需要： 1. 理解用户意图 2. 评估当前信息 3. 决定下一步行动 4. 执行行动并观察结果 5. 基于结果继续思考 思考必须控制在5句话以内，只关注最关键的信息。 不要推测用户未明确表达的需求。 """ def _build_context(self, user_query: str, observations: List[Observation]) -> str: """构建上下文""" if not observations: return "暂无信息" context_lines = [] for i, obs in enumerate(observations, 1): if obs.success: context_lines.append(f"步骤{i}结果：{obs.result}") else: context_lines.append(f"步骤{i}失败：{obs.error}") return "\n".join(context_lines) def _parse_thought(self, response: str) -> Thought: """解析思考""" # 简化实现，实际需要更复杂的解析 lines = response.split('\n') user_intent = "" current_knowledge = "" unknown_info = "" next_action = "" expected_result = "" current_section = None for line in lines: line = line.strip() if line.startswith("**用户意图：**"): current_section = "user_intent" user_intent = line.replace("**用户意图：**", "").strip() elif line.startswith("**当前已知：**"): current_section = "current_knowledge" current_knowledge = line.replace("**当前已知：**", "").strip() elif line.startswith("**未知信息：**"): current_section = "unknown_info" unknown_info = line.replace("**未知信息：**", "").strip() elif line.startswith("**下一步行动：**"): current_section = "next_action" next_action = line.replace("**下一步行动：**", "").strip() elif line.startswith("**预期结果：**"): current_section = "expected_result" expected_result = line.replace("**预期结果：**", "").strip() elif current_section and line and not line.startswith("**"): if current_section == "user_intent": user_intent += " " + line elif current_section == "current_knowledge": current_knowledge += " " + line elif current_section == "unknown_info": unknown_info += " " + line elif current_section == "next_action": next_action += " " + line elif current_section == "expected_result": expected_result += " " + line return Thought( user_intent=user_intent, current_knowledge=current_knowledge, unknown_info=unknown_info, next_action=next_action, expected_result=expected_result ) def _parse_action(self, next_action: str) -> Action: """解析行动""" # 简化实现，实际需要更复杂的解析 if "调用" in next_action and "工具" in next_action: # 提取工具名称 tool_name = next_action.split("调用")[1].split("工具")[0].strip() # 提取参数（简化处理） parameters = {} return Action(tool_name=tool_name, parameters=parameters) # 默认返回空行动 return Action(tool_name="", parameters={}) def _generate_final_response(self, user_query: str, observations: List[Observation]) -> str: """生成最终回复""" context = self._build_context(user_query, observations) prompt = f""" 根据以下信息，回答用户的问题： 用户请求：{user_query} 行动过程： {context} 请直接回答用户的问题，不要提到"思考"、"行动"、"观察"这些技术细节。 """ response = self.llm_client.generate(prompt) return response # 示例：定义工具 def search_weather(location: str) -> dict: """查询天气""" # 模拟实现 return { "location": location, "temperature": 18, "humidity": 65, "wind_speed": 12, "condition": "多云", "pm25": 75 } def calculate_bmi(weight: float, height: float) -> dict: """计算BMI""" bmi = weight / (height ** 2) category = "正常" if bmi < 18.5: category = "偏瘦" elif bmi > 24: category = "偏胖" return { "bmi": round(bmi, 2), "category": category } # 示例：使用Agent if __name__ == "__main__": # 模拟LLM客户端 class MockLLMClient: def generate(self, prompt: str) -> str: # 简化实现，实际应该调用真实的LLM API if "天气" in prompt: return """ ### 思考 **用户意图：** 用户想知道北京的天气情况 **当前已知：** 用户提到了"北京"和"天气" **未知信息：** 北京的具体天气数据（温度、湿度、风速等） **下一步行动：** 调用search_weather工具，查询北京的天气 **预期结果：** 获得北京的实时天气数据 ### 行动

search_weather: {"location": "北京"}

""" elif "BMI" in prompt: return """ ### 思考 **用户意图：** 用户想计算自己的BMI指数 **当前已知：** 体重70kg，身高1.75m **未知信息：** BMI的具体数值和健康等级 **下一步行动：** 调用calculate_bmi工具，计算BMI **预期结果：** 获得BMI数值和健康等级 ### 行动

calculate_bmi: {"weight": 70, "height": 1.75}

""" else: return "完成" # 创建Agent llm_client = MockLLMClient() tools = [ Tool(name="search_weather", description="查询天气", func=search_weather), Tool(name="calculate_bmi", description="计算BMI", func=calculate_bmi) ] agent = ReActAgent(llm_client=llm_client, tools=tools) # 测试 print("=== 测试1：查询天气 ===") result = agent.run("帮我查一下北京的天气") print(result) print() print("=== 测试2：计算BMI ===") result = agent.run("我体重70kg，身高1.75m，帮我算一下BMI") print(result)

**▪ 代码解析**

这个实现包含了ReAct模式的所有核心要素：

1. **思考（think）**：基于上下文生成思考
2. **行动（act）**：从思考中提取行动并执行
3. **观察（observe）**：获取行动结果
4. **循环（run）**：重复思考-行动-观察，直到任务完成

关键设计点：

- **工具抽象**：Tool类统一了工具的接口
- **结构化数据**：Thought、Action、Observation都是dataclass，类型安全
- **错误处理**：observe方法捕获异常，返回失败信息
- **循环控制**：max_steps防止无限循环
- **上下文管理**：_build_context方法构建完整的上下文

**▪ 如何扩展**

这个实现是基础版本，你可以从这些方向扩展：

1. **支持更复杂的工具参数解析**
2. **加入记忆机制，记住历史对话**
3. **支持多轮对话，而不是单次请求**
4. **加入日志记录，便于调试**
5. **支持流式输出，实时展示思考过程**

**最后说句实话**

ReAct模式看起来简单，但用好它不容易。

90%的问题都出在prompt设计上。你的prompt稍微有点歧义，模型就开始胡思乱想；你的prompt不够精确，模型就不知道该怎么做。

**好的prompt不是写出来的，是调出来的。**

你需要：

1. 看模型的思考过程，找出它哪里想错了

2. 调整prompt，纠正它的思考方向

3. 再看、再调，反复迭代

这可能需要几十次尝试。但值得。

因为一旦你的Agent真正"会思考"了，它的能力会指数级提升。它不再是机械地执行命令，而是像一个真正的助手一样，理解你的意图，自主完成任务。

下一篇，我们讲Reflection模式——如何让Agent自我反思，持续改进。

💡 一句话带走：ReAct的核心不是"多了一步"，而是把思考过程显式化。让Agent真正思考，而不是胡思乱想，关键在于prompt设计