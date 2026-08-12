# Code-op C++ 风格要点

> 源自 F:\C++文件\计算器项目 的代码审查沉淀，正例与反例并存。

## 一、应当遵循（正例）

|项|做法|
|---|---|
|多态入口|抽象基类 + 纯虚函数（`virtual void display() = 0`），main 用基类指针指向派生类调用|
|运算符重载|类内声明为 `friend`，成员用 `const` 引用接收（`friend Complex operator+(const Complex&, const Complex&)`）|
|构造初始化|成员初始化列表 `: real(r), imag(i)`，默认实参提供默认构造|
|错误上报|`throw runtime_error("...")` 统一上报，调用处 `try/catch` 捕获并打印 `s.what()`|
|局部判定|C++11 Lambda 封装（`auto is_oper = [](char c){...}`）|
|文档注释|`/// <summary>` 风格 XML 文档|
|头文件防重包含|`#pragma once` 或 `#ifndef` 二选一，宏名与文件名一致|
|include 组织|include 在 guard 内，本地头文件作首个包含（保证自包含），标准库/系统库/本地分组，空行隔开|

## 二、应当避免（反模式，来自计算器项目）

|反模式|修正|
|---|---|
|`#ifndef COMPUTREAM_H` 宏名拼写错误且与 `#pragma once` 重复|只选一种，宏名与文件名一致|
|`Real_number` / `Complex_number` 类名 snake_case|PascalCase：`RealNumber` / `ComplexNumber`|
|`pares_real_expression` 拼写错误，且 camel/snake 混用|统一命名并修正拼写为 `parseRealExpression`|
|.cpp 里 `using namespace std`，main.cpp 又用 `std::` 前缀|同项目风格统一，用 `std::` 前缀|
|`cin.ignore(10000, '\n')` 魔法数字|`cin.ignore(numeric_limits<streamsize>::max(), '\n')` 或定义常量|
|`system("pause")` / `system("chcp 936")` 平台相关、不可移植，且编码不匹配致中文乱码|移除或仅限教学环境，源文件编码统一 UTF-8|
|死代码、注释掉的代码、throw 后不可达 return|清理|
|`display()` 里塞满 cin/cout 与计算逻辑耦合同一类|UI/IO 与业务逻辑分离|
|复数用 int 存实虚部，`operator/` 整数除法截断（1/2=0）|用 double，除零检查后明确处理|
|错误处理混用（部分异常、部分 if/else 打印后 return），main 返回 404|统一一种错误处理模式，错误码语义正确|
|Tab 与 4 空格混用、单语句 if 有无大括号不一致、`#include"computer.h"` 缺空格|统一缩进与格式|
|`isdigit(c)` 直接作用于 char（负数 char 是 UB）|`std::isdigit(static_cast<unsigned char>(c))`|
|头文件里 `static` 内部链接函数，每包含一次复制一份|改为非 static 或在 cpp 内定义|
|默认构造参数 `int o = 0` 传给 char oper，类型不匹配|类型语义明确匹配|

## 三、可复用计算模板

- **中缀转后缀（Shunting-yard）**：`precedence(char op)` 定优先级（`^`=3、`*`/`/`=2、`+`/`-`=1），配合栈与 Lambda 判定。
- **复数运算公式**：`(a+bi)(c+di) = (ac-bd) + (ad+bc)i`。
- **表达式求值**：`parseRealExpression` + 逆波兰（rpnCount）+ 异常上报除零/非法表达式。
