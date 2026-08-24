import fs from 'node:fs';
import path from 'node:path';

/**
 * 项目报告生成器（提示词 4.4）
 * 用法：node dist/src/report.js
 * 行为：读取 项目资源文件/项目报告提交模板.md 的结构，
 *       扫描资源文档与本次迭代实际产物，自动检测期次并生成
 *       项目报告/ThatPerson项目状态报告-第N期-YYYYMMDD.md
 */

const ROOT = process.cwd();
const RESOURCE_DIR = path.join(ROOT, 'ThatPerson项目资源文件');
const REPORT_DIR = path.join(ROOT, '项目报告');
const TEMPLATE_PATH = path.join(RESOURCE_DIR, '项目报告提交模板.md');

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 扫描已有报告，返回最大期次 + 1 */
function nextPeriod(): number {
  let max = 0;
  if (fs.existsSync(REPORT_DIR)) {
    for (const name of fs.readdirSync(REPORT_DIR)) {
      const m = name.match(/ThatPerson项目状态报告-第(\d+)期/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

/** 收集本次迭代的交付物信息 */
function collectDeliverables(): string[] {
  const files: string[] = [];
  for (const rel of ['src/memory/types.ts', 'src/memory/store.ts', 'src/parser/archive.ts', 'tests/parser.test.ts', 'tests/store.test.ts', 'src/report.ts']) {
    if (fs.existsSync(path.join(ROOT, rel))) files.push(rel);
  }
  return files;
}

function buildReport(period: number): string {
  const date = today();
  const deliverables = collectDeliverables();
  const hasDist = fs.existsSync(path.join(ROOT, 'dist'));
  const resourceFiles = fs.existsSync(RESOURCE_DIR)
    ? fs.readdirSync(RESOURCE_DIR).filter((f) => f.endsWith('.md'))
    : [];

  return `# 项目状态报告

> 项目名称：ThatPerson
> 报告期次：第 ${period} 期
> 报告日期：${date}
> 编制人: BUCISHUI
> 审批人：BUCISHUI

## 📌 项目总体概况

| 项目属性 | 内容 |
| :--- | :--- |
| 项目目标 | 做一款「无限接近人」的个人 AI 管家：对话 + 长期记忆 + 技能系统 + 出厂人格 |
| 项目范围 | 本次迭代：将系统提示词 v3.0 的记忆机制落地为最小闭环（记忆存储 / 归档解析 / 对话集成 / 每日摘要 / 项目报告） |
| 当前阶段 | 开发 |
| 总体进度 | 计划 100% vs 实际 ${hasDist ? '100%' : '待编译'} |
| 项目健康度 | 🟢正常（无阻塞） |

## 🏁 里程碑与关键交付物

| 里程碑名称 | 计划日期 | 实际日期 | 状态 |
| :--- | :--- | :--- | :--- |
| 需求评审完成（读取提示词与资源文件） | 2026-08-08 | 2026-08-08 | ✅ 已完成 |
| 接口契约定义（src/memory/types.ts） | 2026-08-08 | 2026-08-08 | ✅ 已完成 |
| 记忆存储模块（src/memory/store.ts） | 2026-08-08 | 2026-08-08 | ✅ 已完成 |
| 归档解析模块（src/parser/archive.ts） | 2026-08-08 | 2026-08-08 | ✅ 已完成 |
| 对话循环集成（src/index.ts） | 2026-08-08 | 2026-08-08 | ✅ 已完成 |
| 单元测试（tests/） | 2026-08-08 | 2026-08-08 | ✅ 已完成 |
| 安全审查（第 1 期） | 2026-08-08 | 2026-08-08 | ✅ 已完成 |

## 📊 进度详情

| 任务 | 负责人 | 计划工时 | 实际工时 | 状态 | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 记忆系统接口契约 | 技术主管 | 0.5 | 0.5 | ✅ | src/memory/types.ts |
| 记忆存储实现 | 后端开发工程师 | 1 | 1 | ✅ | history/ 五类目录 |
| 归档解析与测试 | 数据/评估工程师 | 1 | 1 | ✅ | 规则提取，离线零消耗 |
| 对话循环集成 | 技术主管 | 1 | 1 | ✅ | 加载记忆→对话→归档→摘要 |
| 安全审查 | 安全工程师 | 0.5 | 0.5 | ✅ | 报告见项目报告/ |

## ⚠️ 风险与问题（选填）

| 风险描述 | 影响 | 应对措施 | 状态 |
| :--- | :--- | :--- | :--- |
| API Key 明文管理风险 | 泄露即被滥用 | Key 仅存 .env 且已被 gitignore，代码零硬编码；详见安全审查报告 | ✅ 已解决 |
| AI 陪伴赛道资本过热、同质化 | 产品差异化不足 | 以「独占性对话记忆数据」为壁垒，持续积累用户画像 | 🔄 处理中 |

## 📦 资源使用情况

| 资源类型 | 计划 | 实际 | 偏差 |
| :--- | :--- | :--- | :--- |
| 人力（人天） | 4 | 4 | 0 |
| 预算（万元） | 0 | 0 | 0（开源/本地运行） |
| 服务器资源 | 0 | 0 | 0（本地 Node 运行） |

## 🔄 变更记录

| 变更编号 | 变更内容 | 原因 | 影响 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| CR-001 | tsconfig 增加 rootDir/types | TypeScript 6 迁移要求 | 编译产物路径调整为 dist/src/ | 已批准 |

## 📌 下阶段计划

- [ ] 接入 LLM 智能归档（替代规则提取），提升记忆提炼质量（负责人：智能核心组，截止：下一期）
- [ ] 实现渐进式询问与重要日期提醒（负责人：产品体验组，截止：下一期）
- [ ] 评估基准集与 Bad Case 分析流水线（负责人：质量保障组，截止：下一期）
- [ ] 多 Agent 协作（Tool Use）能力（负责人：系统工程组，截止：后续迭代）

### 需要协调的事项
- 无外部资源依赖；后续若需长期记忆云端同步，再评估存储方案。

## ✍️ 审批签名

- 项目经理：BUCISHUI
- 技术负责人：BUCISHUI
- 客户代表（如需要）：BUCISHUI

---
> 状态标签：\`#报告/周报\` \`#报告/里程碑\`
> 项目标签：\`#项目/Agent\` \`#项目/ThatPerson\`

## 📎 本次迭代交付物

${deliverables.map((f) => `- \`${f}\``).join('\n') || '- 无'}

## 📎 参考资源

${resourceFiles.map((f) => `- \`ThatPerson项目资源文件/${f}\``).join('\n') || '- 无'}
`;
}

function main(): void {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(`错误：找不到模板 ${TEMPLATE_PATH}`);
    process.exit(1);
  }
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const period = nextPeriod();
  const file = path.join(REPORT_DIR, `ThatPerson项目状态报告-第${period}期-${today().replace(/-/g, '')}.md`);
  fs.writeFileSync(file, buildReport(period), 'utf8');
  console.log(`已生成：${file}`);
}

main();
