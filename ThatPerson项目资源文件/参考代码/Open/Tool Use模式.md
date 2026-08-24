# Agent设计模式：Tool Use模式——构建安全的多工具Agent

发布于 2026-05-09 14:27:52

6960

举报

前两篇我们讲了ReAct模式（思考-行动循环）和Reflection模式（自我反思）。今天这篇，讲的是Agent最实用的能力：Tool Use（工具使用）。

工具调用是Agent区别于聊天机器人的核心能力。没有工具，Agent就是个会聊天的AI；

有了工具，Agent就是能干活的数字员工。

但工具调用也是最容易出问题的地方：

- 工具描述被注入恶意指令，Agent被利用做坏事
- 工具参数没校验，导致SQL注入、命令注入
- 代码执行没沙箱，删除了整个数据库
- 50个工具塞进上下文，token爆炸

这些问题，90%的项目都遇到过。

今天这篇，我不只告诉你Tool Use是什么，还要告诉你：**如何构建安全、可控、高效的多工具Agent。**

**Tool Use的本质：让Agent写代码执行操作**

先搞清楚一个概念：Tool Use不是"让Agent调用工具"，而是"让Agent写代码调用工具"。

**▪ 正确做法：让Agent写代码调用工具**

用户：帮我查一下昨天的销售额

Agent思考：需要查询昨天的销售数据。应该使用query_sales工具，参数是date='2026-04-30'。

Agent行动：执行 `result = query_sales(date='2026-04-30')` 和 `print(result)`

执行结果：{'date': '2026-04-30', 'sales': 1250000}

Agent再思考：销售额是125万元，需要给用户更友好的回复。

Agent行动：执行 `print(f"昨日销售额：{result['sales']/10000:.1f}万元")`

执行结果：昨日销售额：125.0万元

看出来了吗？Agent不是直接调用工具，而是**写Python代码，代码里调用工具**。

这样做的好处有三个：

**第一，工具定义在代码库，不在上下文。**

上下文里只需要说明："你可以写Python代码，代码里可以调用以下函数：query_sales, send_email, calculate_bmi"。具体的函数实现、参数说明，都在代码里，不占token。

**第二，代码是可见的、可审计的。**

Agent写的每一行代码，你都能看到。如果它想执行恶意操作，你能立即发现并阻止。

**第三，扩展简单。**

加新工具，只需要：

1. 写工具函数（Python函数）

2. 在系统prompt里加一行"新增工具：xxx"

不需要写复杂的工具描述，不需要担心token爆炸。

这就是Tool Use模式的核心思想：**Agent写代码，代码执行操作。**

**工具定义的最佳实践**

**▪ 原则1：工具接口要标准化**

**✅ 正确的接口设计：**

# 统一使用蛇形命名（Python风格） def query_sales_data(date: str) -> dict: """查询销售数据""" pass def send_email(user_id: str, subject: str, content: str) -> bool: """发送邮件""" pass def calculate_bmi(height: float, weight: float) -> dict: """计算BMI""" pass

**标准化接口的规则：**

1. **命名风格**：统一使用snake_case（Python）或camelCase（JavaScript）
2. **参数顺序**：必选参数在前，可选参数在后
3. **返回类型**：统一返回dict或特定类型，不要混用
4. **错误处理**：统一抛出异常或返回错误码

**▪ 原则2：工具参数要有类型注解**

**✅ 正确的设计：**

from datetime import date from typing import Dict, Any def query_sales(query_date: date) -> Dict[str, Any]: """ 查询销售数据 Args: query_date: 查询日期，格式为YYYY-MM-DD Returns: dict: 包含日期和销售额 { "date": "2026-04-30", "sales": 1250000 } """ pass

类型注解的好处：

1. **LLM更容易理解**：看到`query_date: date`，就知道应该传什么

2. **IDE能提供智能提示**：开发时更方便

3. **运行时可以校验**：参数类型错误能及时报错

**▪ 原则3：工具描述要精准**

**✅ 正确的描述：**

def query_sales(query_date: str) -> dict: """ 查询指定日期的销售数据 功能： - 只能查询销售表（sales_table） - 只能按日期查询，不支持复杂SQL - 返回当天的总销售额 限制： - 不能删除、修改数据 - 不能查询其他表 - 日期格式必须为YYYY-MM-DD Args: query_date: 查询日期，格式为YYYY-MM-DD Returns: dict: {"date": "2026-04-30", "sales": 1250000} Raises: ValueError: 日期格式错误 PermissionError: 无权限访问 """ pass

精准的描述应该包含：

- **功能**：工具能做什么
- **限制**：工具不能做什么
- **参数**：每个参数的详细说明
- **返回值**：返回数据的结构
- **异常**：可能抛出的错误

**▪ 原则4：工具要有安全的默认值**

**✅ 正确的设计：**

from typing import List, Optional def send_email( to: str, subject: str, content: str, priority: str = "normal", # 默认值 cc: Optional[List[str]] = None, # 可选参数 bcc: Optional[List[str]] = None ) -> bool: """ 发送邮件 Args: to: 收件人邮箱 subject: 邮件主题 content: 邮件内容 priority: 优先级，可选值：low/normal/high，默认为normal cc: 抄送列表，可选 bcc: 密送列表，可选 Returns: bool: 是否发送成功 """ # 处理可选参数 if cc is None: cc = [] if bcc is None: bcc = [] pass # Agent调用时只需提供必要参数 send_email(to="user@example.com", subject="测试", content="内容")

安全的默认值规则：

- **优先级**：默认normal，不是high或low
- **数量限制**：默认限制为合理值（如查询最多1000条）
- **权限**：默认只读，需要明确授权才能写
- **超时**：默认30秒，避免无限等待

**代码沙箱安全设计**

让Agent写代码，最大的风险是：代码会做什么，你不知道。它可能删除文件、访问网络、泄露数据。

所以需要代码沙箱：限制代码能做什么，不能做什么。

**▪ 方案1：使用RestrictedPython**

RestrictedPython是Python的一个安全执行环境，它会：

- 限制可以使用的内置函数（如不能直接用open、import）
- 禁止访问不安全的属性（如**import**、**builtins**）
- 提供安全的替代函数

**安装：**

pip install RestrictedPython

**使用示例：**

from RestrictedPython import compile_restricted from RestrictedPython.Guards import safe_builtins, guarded_iter_unpack_sequence from RestrictedPython.PrintCollector import PrintCollector import sys def execute_in_sandbox(code: str, global_vars: dict) -> str: """在沙箱中执行代码""" # 1. 编译代码 byte_code = compile_restricted(code, filename="", mode="exec") if byte_code.errors: raise ValueError(f"代码编译错误：{byte_code.errors}") # 2. 准备安全的环境 safe_globals = { '__builtins__': safe_builtins, '_print_': PrintCollector, '_getiter_': iter, '_iter_unpack_sequence_': guarded_iter_unpack_sequence, } # 3. 添加允许使用的工具 safe_globals.update(global_vars) # 4. 执行代码 local_vars = {} exec(byte_code.code, safe_globals, local_vars) # 5. 获取输出 if '_print' in local_vars: return local_vars['_print'].getvalue() return "" # 示例：安全执行代码 code = 'result = query_sales(date="2026-04-30")\nprint(f"销售额：{result[\"sales\"]}元")' # 定义允许使用的工具 tools = { 'query_sales': query_sales } # 执行 output = execute_in_sandbox(code, tools) print(output) # 销售额：1250000元

**RestrictedPython的限制：**

1. 不能直接import（需要白名单）
2. 不能使用open、exec、eval等危险函数
3. 不能访问**import**、**builtins**等特殊属性

**▪ 实战：一个完整的代码沙箱**

下面是一个综合方案，结合RestrictedPython和白名单机制：

from RestrictedPython import compile_restricted from RestrictedPython.Guards import safe_builtins, guarded_iter_unpack_sequence from RestrictedPython.PrintCollector import PrintCollector import ast import re class CodeSandbox: """代码沙箱""" # 允许导入的模块（白名单） ALLOWED_IMPORTS = { 'math', 'datetime', 'json', 're', 'random' } # 禁止的函数（黑名单） FORBIDDEN_FUNCTIONS = { 'open', 'exec', 'eval', 'compile', '__import__', 'globals', 'locals', 'vars' } # 允许的工具函数 tools: dict = {} def __init__(self, tools: dict = None): if tools: self.tools = tools def check_code_safety(self, code: str) -> tuple[bool, str]: """检查代码安全性""" # 1. 检查是否包含禁止的函数 for func in self.FORBIDDEN_FUNCTIONS: if func in code: return False, f"禁止使用函数：{func}" # 2. 检查import语句 try: tree = ast.parse(code) for node in ast.walk(tree): if isinstance(node, ast.Import): for alias in node.names: if alias.name not in self.ALLOWED_IMPORTS: return False, f"禁止导入模块：{alias.name}" elif isinstance(node, ast.ImportFrom): if node.module not in self.ALLOWED_IMPORTS: return False, f"禁止从模块导入：{node.module}" except SyntaxError as e: return False, f"语法错误：{e}" # 3. 检查是否有危险的字符串操作（如__class__） dangerous_patterns = [ r'__\w+__', # 魔术方法 r'globals\(\)', r'locals\(\)', r'eval\(', r'exec\(' ] for pattern in dangerous_patterns: if re.search(pattern, code): return False, f"检测到危险代码模式：{pattern}" return True, "" def execute(self, code: str) -> tuple[str, bool]: """执行代码""" # 1. 检查代码安全性 is_safe, error_msg = self.check_code_safety(code) if not is_safe: return f"安全检查失败：{error_msg}", False # 2. 编译代码 byte_code = compile_restricted(code, filename="", mode="exec") if byte_code.errors: return f"代码编译错误：{byte_code.errors}", False # 3. 准备安全的环境 safe_globals = { '__builtins__': safe_builtins, '_print_': PrintCollector, '_getiter_': iter, '_iter_unpack_sequence_': guarded_iter_unpack_sequence, } # 4. 添加允许导入的模块 for module_name in self.ALLOWED_IMPORTS: try: __import__(module_name) safe_globals[module_name] = sys.modules[module_name] except ImportError: pass # 5. 添加工具函数 safe_globals.update(self.tools) # 6. 执行代码 try: local_vars = {} exec(byte_code.code, safe_globals, local_vars) # 7. 获取输出 if '_print' in local_vars: return local_vars['_print'].getvalue(), True else: return "代码执行成功，但无输出", True except Exception as e: return f"执行错误：{str(e)}", False # 使用示例 if __name__ == "__main__": import sys # 定义工具函数 def query_sales(date: str) -> dict: return {"date": date, "sales": 1250000} def calculate_bmi(weight: float, height: float) -> dict: bmi = weight / (height ** 2) return {"bmi": round(bmi, 2)} # 创建沙箱 sandbox = CodeSandbox(tools={ 'query_sales': query_sales, 'calculate_bmi': calculate_bmi }) # 测试1：安全代码 safe_code = 'result = query_sales(date="2026-04-30")\nprint(f"销售额：{result[\"sales\"]}元")' output, success = sandbox.execute(safe_code) print(f"测试1：{output}") # 测试2：危险代码（应该被阻止） dangerous_code = 'import os\nprint(os.listdir("."))' output, success = sandbox.execute(dangerous_code) print(f"测试2：{output}") # 测试3：禁止的函数（应该被阻止） forbidden_code = 'eval(\'print("hello")\')' output, success = sandbox.execute(forbidden_code) print(f"测试3：{output}")

输出：

测试1：销售额：1250000元 测试2：安全检查失败：禁止导入模块：os 测试3：安全检查失败：禁止使用函数：eval

这个沙箱实现了：

- 代码安全检查（AST分析）
- 模块白名单
- 函数黑名单
- RestrictedPython编译
- 安全的执行环境

**完整的SafeToolAgent实现**

现在我们把所有内容整合起来，构建一个完整的、安全的多工具Agent。

import json from typing import Dict, List, Any, Callable from dataclasses import dataclass from RestrictedPython import compile_restricted from RestrictedPython.Guards import safe_builtins from RestrictedPython.PrintCollector import PrintCollector import ast import re @dataclass class Tool: """工具定义""" name: str func: Callable description: str class SafeToolAgent: """安全的多工具Agent""" def __init__(self, llm_client, tools: List[Tool]): self.llm_client = llm_client self.tools = {tool.name: tool for tool in tools} self.sandbox = CodeSandbox(tools={t.name: t.func for t in tools}) def run(self, user_query: str, max_iterations: int = 5) -> str: """运行Agent""" user_query_history = [user_query] for iteration in range(max_iterations): print(f"\n=== 迭代 {iteration + 1} ===") # 1. 生成系统prompt system_prompt = self._generate_system_prompt() # 2. 调用LLM生成代码 messages = [ {"role": "system", "content": system_prompt}, {"role": "user", "content": user_query_history[-1]} ] response = self.llm_client.generate(messages) # 3. 从响应中提取代码 code = self._extract_code_from_response(response) if not code: return "无法提取代码，请重试" # 4. 在沙箱中执行代码 output, success = self.sandbox.execute(code) print(f"执行结果：{output}") if not success: user_query_history.append(f"代码执行失败：{output}\n请重新尝试。") continue # 5. 判断任务是否完成 completion_prompt = f''' 用户请求：{user_query} 代码执行结果： {output} 这个结果是否已经回答了用户的问题？如果已经回答，请说"完成"；如果还需要更多信息，请说明需要什么。 ''' completion_check = self.llm_client.generate([ {"role": "system", "content": "你是一个助手，判断任务是否完成。"}, {"role": "user", "content": completion_prompt} ]) if "完成" in completion_check or "yes" in completion_check.lower(): # 生成最终回答 final_prompt = f''' 请基于以上结果，给用户一个清晰、友好的回答。不要提到"代码"、"工具"等技术细节。 ''' final_response = self.llm_client.generate([ {"role": "system", "content": "你是一个助手，帮助用户。"}, {"role": "user", "content": final_prompt} ]) return final_response # 6. 未完成，继续迭代 user_query_history.append(f"基于之前的结果：{output}\n继续完成任务。") return "任务未能在最大迭代次数内完成。" def _generate_system_prompt(self) -> str: """生成系统prompt""" tool_descriptions = [] for tool_name, tool in self.tools.items(): sig = str(tool.func.__annotations__) tool_descriptions.append(f"- {tool_name}{sig}: {tool.description}") system_prompt = f''' 你是一个智能助手，可以使用工具完成任务。 可用工具： {chr(10).join(tool_descriptions)} 使用方法： 1. 思考用户需要什么 2. 决定使用哪个工具 3. 写Python代码调用工具 4. 从输出中提取关键信息 5. 回答用户的问题 注意事项： - 代码中只能使用上述列出的工具 - 不要使用open、exec、eval等危险函数 - 代码必须能直接运行，不要有语法错误 ''' return system_prompt def _extract_code_from_response(self, response: str) -> str: """从响应中提取代码""" import re pattern = r'```python\n(.*?)\n```' match = re.search(pattern, response, re.DOTALL) if match: return match.group(1).strip() return "" # 示例：定义工具 def query_weather(location: str) -> dict: """查询天气""" weather_data = { "北京": {"temperature": 18, "humidity": 65, "condition": "多云"}, "上海": {"temperature": 22, "humidity": 70, "condition": "晴"}, "广州": {"temperature": 28, "humidity": 80, "condition": "雷阵雨"} } return weather_data.get(location, {"error": "未找到该城市"}) def calculate_bmi(weight: float, height: float) -> dict: """计算BMI指数""" bmi = weight / (height ** 2) category = "正常" if bmi < 18.5: category = "偏瘦" elif bmi > 24: category = "偏胖" return {"bmi": round(bmi, 2), "category": category} def search_products(keyword: str, category: str = "all") -> list: """搜索商品""" products = [ {"name": "iPhone 15", "price": 5999, "category": "手机"}, {"name": "MacBook Pro", "price": 14999, "category": "电脑"}, {"name": "AirPods", "price": 999, "category": "耳机"}, {"name": "iPad Air", "price": 4399, "category": "平板"} ] results = [] for product in products: if (keyword.lower() in product['name'].lower() and (category == "all" or product['category'] == category)): results.append(product) return results # 模拟LLM客户端 class MockLLMClient: """模拟LLM客户端""" def generate(self, messages: list) -> str: """生成回复（简化实现）""" user_message = messages[-1]['content'] if "天气" in user_message or "weather" in user_message.lower(): return ''' 我需要查询天气数据。 result = query_weather(location='北京') print(result) ''' elif "BMI" in user_message or "bmi" in user_message.lower(): return ''' 我需要计算BMI。 result = calculate_bmi(weight=70, height=1.75) print(result) ''' elif "商品" in user_message or "product" in user_message.lower(): return ''' 我需要搜索商品。 result = search_products(keyword='iPhone', category='手机') print(result) ''' elif "完成" in user_message: return "完成" else: return "我不太理解，请提供更多信息。" # 使用示例 if __name__ == "__main__": # 创建LLM客户端 llm_client = MockLLMClient() # 创建工具 tools = [ Tool("query_weather", query_weather, "查询天气"), Tool("calculate_bmi", calculate_bmi, "计算BMI"), Tool("search_products", search_products, "搜索商品") ] # 创建Agent agent = SafeToolAgent(llm_client=llm_client, tools=tools) # 测试1：查询天气 print("=" * 60) print("测试1：查询天气") print("=" * 60) result = agent.run("帮我查一下北京的天气") print(f"\n最终回答：{result}\n") # 测试2：计算BMI print("=" * 60) print("测试2：计算BMI") print("=" * 60) result = agent.run("我体重70kg，身高1.75m，帮我算一下BMI") print(f"\n最终回答：{result}\n") # 测试3：搜索商品 print("=" * 60) print("测试3：搜索商品") print("=" * 60) result = agent.run("帮我搜索一下iPhone") print(f"\n最终回答：{result}\n")

**▪ 代码解析**

这个实现包含了Tool Use模式的所有核心要素：

1. **工具注册机制**：Tool类统一工具接口
2. **代码沙箱**：基于RestrictedPython的安全执行环境
3. **安全检查**：AST分析检查危险代码
4. **迭代执行**：支持多轮迭代，逐步完成任务
5. **完成判断**：自动判断任务是否完成

**关键设计点：**

- **工具抽象**：Tool类统一工具接口
- **自动生成工具描述**：从函数签名和docstring自动生成工具信息
- **代码提取**：从LLM响应中提取Python代码
- **错误恢复**：执行失败后让LLM重新尝试
- **自然语言回答**：最终生成友好的自然语言回复

**最后说句实话**

Tool Use模式看起来简单，但真正用好它，需要考虑三个问题：

**第一，安全。** 代码沙箱不是可有可无的，是必须的。我见过太多项目因为没做沙箱，导致Agent删库、泄露数据。安全不是事后补救，是事前设计。

**第二，标准化。** 工具接口不统一，Agent就会乱。50个工具有50种接口风格，LLM根本记不住。标准化接口看起来麻烦，但能省下大量调试时间。

**第三，可扩展性。** 今天你有10个工具，明天可能有100个。设计的时候就要考虑动态发现、自动注册，不要每次加工具都改prompt。

**工具调用是Agent最实用的能力，也是最容易出问题的地方。** 用好了，Agent能干很多事；用不好，Agent就是个定时炸弹。