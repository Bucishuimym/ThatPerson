# Vault API 自动化使用说明

> 版本：2.1.0  
> 适用：Obsidian 知识库自动化读取（自动探测 Obsidian / 仓库，适配 PARA 与任意结构）  
> 位置：`scripts/自动化脚本/`（本 skill 目录下）

---

## 一、设计架构

```
┌─────────────────────────────────────────────────────────────┐
│                     环境探测层                                │
│              vault_env.py                                    │
│    自动检测 Obsidian / 仓库，一键接入 setup_api()             │
├─────────────────────────────────────────────────────────────┤
│                     Agent 调用层                             |
│              vault_api.py (VaultAPI)                         │
│    统一入口：execute(action, params)                          │
│    支持动作：initialize / read / search / ocr / ...           │
├─────────────────────────────────────────────────────────────┤
│                     查询逻辑层                                │
│              vault_query.py (VaultQuery)                     │
│    关键词搜索 / 标签过滤 / OCR搜索 / 高级组合查询              │
├─────────────────────────────────────────────────────────────┤
│                     核心读取层                                │
│              vault_reader.py (VaultReader)                   │
│    文件扫描 / 元数据提取 / 编码处理 / OCR识别                  │
├─────────────────────────────────────────────────────────────┤
│                     外部依赖层                                │
│    PaddleOCR  │  Python标准库                                │
│    (可选，图片文字识别)  │  (路径/正则/JSON等)                │
└─────────────────────────────────────────────────────────────┘
```

### 数据流

```
vault_env.py 探测 → 自动定位本机 Obsidian 默认仓库
    ↓
Agent 请求 → VaultAPI.execute(action, params)
    ↓
VaultReader.scan() → 遍历仓库所有支持的文件（先探测结构）
    ↓
对每个文件：
  ├─ 文本文件(.md/.py/.cpp/.json/.txt...) → 直接读取内容
  └─ 图片文件(.jpg/.png/.bmp...) → PaddleOCR 识别文字
    ↓
提取元数据：
  ├─ frontmatter (YAML头)
  ├─ 标签 (#tag)
  ├─ 内部链接 ([[wikilink]])
  ├─ 编程语言识别
  └─ 结构自适应分类（PARA 或 顶层目录名）
    ↓
VaultQuery 提供搜索/过滤/统计能力
    ↓
返回结构化 JSON 给 Agent
```

---

## 二、支持的文件类型

### 文本文件（直接读取）

| 扩展名 | 语言/格式 | 说明 |
|--------|-----------|------|
| `.md`, `.markdown` | Markdown | Obsidian笔记 |
| `.txt` | 纯文本 | 通用文本 |
| `.json` | JSON | 自动格式化缩进 |
| `.py` | Python | 源码 |
| `.cpp`, `.c`, `.h`, `.hpp` | C/C++ | 源码 |
| `.cs` | C# | 源码 |
| `.java` | Java | 源码 |
| `.js`, `.ts`, `.jsx`, `.tsx` | JavaScript/TypeScript | 源码 |
| `.html`, `.css`, `.vue` | 前端 | 源码 |
| `.xml`, `.yaml`, `.yml` | 数据格式 | 配置/数据 |
| `.ini`, `.cfg`, `.conf` | 配置文件 | 配置 |
| `.log` | 日志 | 日志文件 |
| `.csv` | CSV | 表格数据 |
| `.bat`, `.ps1`, `.sh`, `.bash` | 脚本 | 批处理脚本 |

### 图片文件（PaddleOCR 识别）

| 扩展名 | 说明 |
|--------|------|
| `.jpg`, `.jpeg` | JPEG图片 |
| `.png` | PNG图片 |
| `.bmp` | BMP位图 |
| `.tiff`, `.tif` | TIFF图片 |
| `.gif` | GIF动图 |
| `.webp` | WebP图片 |

---

## 三、Agent 如何调用 API

### 方式一：Python 代码调用

```python
from vault_env import setup_api

# 1. 一键创建API实例（自动探测本机默认仓库；也可 setup_api(r"<仓库绝对路径>") 显式指定）
api = setup_api()

# 2. 初始化仓库（首次调用必须）
result = api.initialize()

# 3. 读取文件
note = api.read_note("3-资源库/04-知识参考/Agent管理.md")

# 4. 搜索内容
results = api.search(keyword="大语言模型")

# 5. OCR图片识别
ocr_result = api.ocr_image("8-素材库/20260628.jpg")

# 6. 通用执行接口（推荐）
result = api.execute("search", {"keyword": "Agent"})
```

### 方式二：命令行调用

```bash
# 未传 --path 时自动探测本机 Obsidian 默认仓库
# 获取仓库信息
python vault_api.py --action get_info

# 搜索关键词
python vault_api.py --action search --params "{\"keyword\":\"大语言模型\"}"

# 读取特定文件
python vault_api.py --action read_note --params "{\"path\":\"3-资源库/04-知识参考/Agent管理.md\"}"

# OCR图片识别
python vault_api.py --action ocr_image --params "{\"path\":\"8-素材库/20260628.jpg\"}"

# 获取需要OCR的图片列表
python vault_api.py --action get_images_needing_ocr

# 导出结果到文件
python vault_api.py --action search --params "{\"keyword\":\"LLM\"}" --output result.json
```

### 方式三：高级用法

```python
from vault_env import setup_api

api = setup_api()   # 自动探测仓库
api.initialize()

# 高级搜索（多条件组合）
results = api.query.advanced_search(
    keywords=["Agent", "LLM"],
    tags=["提示词"],
    folder="3-资源库",
    file_type="text",
    min_word_count=100,
)

# 获取关联笔记
related = api.query.get_related_notes("3-资源库/04-知识参考/Agent管理.md")

# 获取未OCR的图片
images = api.query.get_images_needing_ocr(limit=30)

# 批量OCR
paths = [img['path'] for img in images]
batch = api.reader.batch_ocr(paths)
```

---

## 四、动作与参数说明

### 动作一览表

| 动作 | 说明 | 必要参数 | 可选参数 |
|------|------|----------|----------|
| `initialize` | 初始化仓库扫描 | - | `force_rescan` |
| `get_info` | 仓库概览/统计/结构（含 `structure`、`categories`） | - | - |
| `read_note` | 读取单个文件 | `path` | - |
| `read_file` | 读取文件(自动OCR) | `path` | - |
| `list_notes` | 列出文件 | - | `folder`, `category`, `tag`, `file_type`, `ext` |
| `search` | 搜索文件 | - | `keyword`, `tags`, `folder`, `category`, `mode` |
| `ocr_image` | OCR识别单张图片 | `path` | - |
| `batch_ocr` | 批量OCR识别 | `paths` | - |
| `get_images_needing_ocr` | 获取未OCR图片 | - | `limit` |
| `ocr_all_images` | 批量OCR所有图片 | - | `limit` |
| `get_tags` | 获取所有标签 | - | - |
| `get_extensions` | 获取扩展名统计 | - | - |
| `get_recent` | 最近修改的文件 | - | `limit` |
| `get_diaries` | 获取日记列表 | - | `limit` |
| `get_folder_content` | 获取文件夹内容 | `folder` | - |
| `read_multiple_notes` | 批量读取文件 | `paths` | - |
| `get_diary_by_date` | 按日期找日记 | `date` | - |
| `get_supported_extensions` | 获取支持的扩展名 | - | - |
| `get_ocr_status` | 获取OCR状态 | - | - |

### 参数详细说明

#### `initialize`
```json
{
  "force_rescan": false   // 是否强制重新扫描
}
```

#### `read_note` / `read_file`
```json
{
  "path": "3-资源库/04-知识参考/Agent管理.md"  // 文件相对路径
}
```

#### `list_notes`
```json
{
  "folder": "3-资源库",           // 文件夹路径前缀匹配
  "category": "resource",         // 分类: PARA 结构为 inbox/project/...；其他结构为顶层目录名（先 get_info 看 categories）
  "tag": "提示词",                // 标签过滤
  "file_type": "text",            // 文件类型: text/image
  "ext": ".py"                    // 文件扩展名
}
```

#### `search`
```json
{
  "keyword": "Agent",             // 搜索关键词
  "tags": ["提示词", "Agent"],    // 标签搜索
  "folder": "3-资源库",           // 文件夹过滤
  "category": "resource",         // 分类过滤
  "mode": "keyword"               // 搜索模式: keyword/tag/ocr/advanced
}
```

#### `ocr_image`
```json
{
  "path": "8-素材库/20260628.jpg"  // 图片文件路径
}
```

#### `batch_ocr`
```json
{
  "paths": [                      // 图片路径数组
    "8-素材库/img1.jpg",
    "8-素材库/img2.png"
  ]
}
```

#### `get_diary_by_date`
```json
{
  "date": "2026-08-07"           // 日期，支持多种格式
}
```

---

## 五、返回值格式

所有 API 返回统一的 JSON 格式：

```json
{
  "status": "success",           // success / error / partial_success
  "action": "search",            // 执行的动作名称
  "message": "...",              // 可选的消息
  "data": { ... },               // 返回的数据
  "count": 10,                   // 结果数量（列表类接口）
  "error": "...",                // 错误信息
  "errors": [...]                // 部分失败详情
}
```

### 典型返回示例

**读取文件：**
```json
{
  "status": "success",
  "action": "read_note",
  "data": {
    "path": "3-资源库/04-知识参考/Agent管理.md",
    "title": "Agent管理",
    "folder": "3-资源库/04-知识参考",
    "file_ext": ".md",
    "file_type": "text",
    "language": "markdown",
    "tags": ["agent", "ai"],
    "links": ["LLM 大语言模型"],
    "word_count": 1523,
    "content": "# Agent管理\n\n...文件内容..."
  }
}
```

**OCR 识别：**
```json
{
  "status": "success",
  "action": "ocr_image",
  "file_path": "8-素材库/20260628.jpg",
  "text": "图片中识别出的文字内容...",
  "text_count": 15,
  "confidence_avg": 0.9523,
  "details": [
    {
      "text": "第一行文字",
      "confidence": 0.9876,
      "bbox": [[10.5, 20.3], [100.2, 20.3], [100.2, 35.8], [10.5, 35.8]]
    }
  ]
}
```

**搜索结果：**
```json
{
  "status": "success",
  "action": "search",
  "count": 5,
  "data": [
    {
      "path": "3-资源库/04-知识参考/Agent管理.md",
      "title": "Agent管理",
      "file_type": "text",
      "file_ext": ".md",
      "tags": ["agent"],
      "word_count": 1523,
      "snippet": "...包含关键词的上下文片段..."
    }
  ]
}
```

---

## 六、PaddleOCR 安装与配置

### 安装步骤

```bash
# 1. 安装 PaddlePaddle
pip install paddlepaddle

# 2. 安装 PaddleOCR
pip install paddleocr

# 3. 验证安装
python -c "from paddleocr import PaddleOCR; print('PaddleOCR 安装成功')"
```

### 系统要求

- Python >= 3.8
- 支持 Windows / Linux / macOS
- 建议使用 GPU 加速（可选，CPU 也可运行）

### 不安装 PaddleOCR 的情况

如果不安装 PaddleOCR，脚本仍然可以：
- ✅ 扫描和列出图片文件
- ✅ 读取所有文本文件
- ✅ 进行关键词/标签搜索
- ❌ 无法对图片进行 OCR 文字识别

---

## 七、文件说明

### 文件清单

| 文件 | 作用 | 说明 |
|------|------|------|
| `vault_reader.py` | 核心读取模块 | 文件扫描、元数据提取、OCR识别 |
| `vault_query.py` | 查询模块 | 搜索、过滤、统计、关联查找 |
| `vault_api.py` | API 接口层 | 对外暴露的统一调用接口 |
| `vault_env.py` | 环境探测层 | 自动检测 Obsidian/仓库、一键接入 `setup_api()`、下载安装包 |
| `example_usage.py` | 使用示例 | 演示各种调用方式 |
| `__init__.py` | 包初始化 | 导出公共接口 |
| `适配Obsidian的自动化.md` | 本文档 | 完整使用说明 |

### 类结构

```python
# vault_reader.py
class NoteMetadata:       # 文件元数据数据类
class VaultReader:        # 文件读取器核心类

# vault_query.py
class VaultQuery:         # 查询器类

# vault_api.py
class VaultAPI:           # 对外API类（主要入口）
def create_api(path):     # 工厂函数

# vault_env.py
def setup_api(path=None)  # 一键：定位脚本目录 + 探测默认仓库 + 返回 API 实例
def setup_check()         # 环境自检报告（Obsidian 是否安装、有哪些仓库、默认仓库）
def find_obsidian_executable() / find_vaults() / pick_default_vault()
def download_obsidian()   # 下载 Obsidian 安装包（调用前须先征得用户同意）
```

### 关键依赖

```python
# 标准库
import os          # 文件遍历
import re          # 正则匹配（标签、链接提取）
import json        # JSON文件处理
from pathlib import Path  # 路径处理
from dataclasses import dataclass, field  # 数据类
from datetime import datetime  # 时间处理
from typing import Dict, List, Optional, Any  # 类型注解

# 可选依赖
from paddleocr import PaddleOCR  # OCR识别
```

---

## 八、外部引用与扩展

### Obsidian 知识库结构参考

- [知识库分类指引.md](知识库分类指引.md) - PARA 分类规则（PARA 风格仓库适用）
- [仓库结构.md](仓库结构.md) - 当前仓库结构（PARA 风格参考）

### PaddleOCR 官方资源

- 官方文档：[https://paddleocr.bj.bcebos.com/](https://paddleocr.bj.bcebos.com/)
- GitHub：[https://github.com/PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)

### 扩展思路

1. **数据库存储**：将扫描结果存入 SQLite/Redis，加速查询
2. **定时扫描**：使用 `Schedule` 定时更新索引
3. **向量搜索**：集成 Embedding 模型实现语义搜索
4. **多仓库并行扫描**：`vault_env.py` 已能列出本机全部仓库，可进一步让 `VaultReader` 一次扫多路径
5. **Web 服务**：将 API 封装为 Flask/FastAPI 服务
6. **增量更新**：基于文件修改时间实现增量扫描

---

## 九、快速开始 Checklist

- [ ] Python >= 3.8 已安装
- [ ] PaddleOCR 已安装（可选，图片识别需要）
- [ ] `python vault_env.py` 自检通过（Obsidian 已装、有默认仓库）
- [ ] 运行 `python example_usage.py` 验证环境
- [ ] Agent 通过 `VaultAPI.execute()` 调用
- [ ] 处理返回的 JSON 数据
- [ ] 错误状态检查（`status` 字段）

---

## 十、常见问题

### Q: 为什么扫描不到文件？
检查仓库路径是否正确，以及文件扩展名是否在支持列表中。

### Q: PaddleOCR 报错怎么办？
- 确认 Python 版本 >= 3.8
- 尝试 `pip install --upgrade paddleocr paddlepaddle`
- Windows 用户可参考 [PaddleOCR Windows 安装指南](https://paddleocr.bj.bcebos.com/ppocr/latest/quick_start/windows.html)

### Q: 如何只扫描特定文件夹？
使用 `list_notes(folder="3-资源库")` 或 `search(folder="3-资源库")`

### Q: 如何搜索代码文件内容？
使用 `search(keyword="function", mode="keyword")` 会自动搜索所有文件内容

### Q: OCR 识别准确率低怎么办？
- 确保图片清晰、文字朝向正确
- 可以尝试在 OCR 前对图片进行预处理（灰度化、二值化等）
- 使用 `use_angle_cls=True` 参数（已默认启用）

### Q: 换电脑 / 换了一个新仓库，需要改代码吗？
不需要。`vault_env.py` 读取本机 Obsidian 配置（`%APPDATA%/obsidian/obsidian.json`）自动挑选默认仓库；脚本用 `setup_api()`、命令行不传 `--path` 即可。仓库不是 PARA 结构时，`get_info` 返回的 `structure` 会标记 `para_compatible: false`，分类自动退化为「顶层目录名」。

### Q: 本机没装 Obsidian 怎么办？
先 `python vault_env.py` 自检确认 `obsidian_installed: false`，向用户说明并征得同意后运行 `python vault_env.py --download`，下载安装包到「下载」目录，再请用户运行安装。装好后重新自检即可。
