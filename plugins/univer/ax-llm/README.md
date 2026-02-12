# Ax（`@ax-llm/ax`）文档导读（按开发时常用程度排序）

本仓库里 Ax 主要用于 Univer 的 AI loopback（后端 headless tool-call / agent flow）。Ax 的上游文档较多，这里做一个“按需查”的索引：**先看最常用的**，再按场景深入。

> 上游文档在：`plugins/univer/ax-llm/docs/`（文件名即主题）。

## 30 秒定位：我现在要看哪篇？

- **先跑通一次最小例子** → `./docs/QUICKSTART.md`
- **选 provider / model / thinking / stream / common options** → `./docs/AI.md`
- **写签名（signature）+ 类型约束 + 校验/断言（最核心）** → `./docs/SIGNATURES.md`
- **理解 “DSPy in TS” 的整体思路（概念扫盲）** → `./docs/DSPY.md`
- **看能抄的代码形态（提速）** → `./docs/EXAMPLES.md`
- **单步生成单元（重试、流式、模板、assertions）** → `./docs/AXGEN.md`
- **需要 tool-use / 多步推理 / 子 agent / RLM 长上下文** → `./docs/AXAGENT.md`
- **需要工作流编排（依赖分析/并行/控制流）** → `./docs/AXFLOW.md`
- **要做 RAG（多跳检索、自愈、gap analysis）** → `./docs/AXRAG.md`

## 常用阅读顺序（推荐）

1. `./docs/QUICKSTART.md`（跑起来）
2. `./docs/AI.md`（模型与参数心智模型）
3. `./docs/SIGNATURES.md`（签名是 Ax 的“主语言”）
4. `./docs/AXGEN.md`（最常用的执行单元）
5. `./docs/EXAMPLES.md`（对齐项目里你想写的代码形态）
6. 需要再补：`./docs/AXAGENT.md` / `./docs/AXFLOW.md` / `./docs/AXRAG.md`

## 开发时的“问题 → 文档”映射

- **我想把输入输出都做成强类型，避免模型乱写字段** → `./docs/SIGNATURES.md`
- **我想要失败自动重试/断言失败触发重试** → `./docs/AXGEN.md`（也可顺便看 `./docs/EXAMPLES.md`）
- **我想做 function calling / tool schemas / 工具失败自动修 args** → 先看 `./docs/AXAGENT.md`，再回头查 `./docs/AI.md` 的 `functionCallMode`
- **我想把一个任务拆成多个步骤、并行跑、最后汇总** → `./docs/AXFLOW.md`
- **我想做“检索-生成-自检-补检索-修复”闭环** → `./docs/AXRAG.md`
- **我想降低成本/提高质量，做自动优化/训练** →
  - 入门总览：`./docs/OPTIMIZE.md`
  - 生产日志驱动自改进：`./docs/LEARN.md`
  - 主力优化器：`./docs/MIPRO.md`
  - 多目标进化：`./docs/GEPA.md`
  - “长期进化 playbook”式上下文工程：`./docs/ACE.md`

## 生产化与维护类（不常看，但需要时很关键）

- **观测/Tracing/OpenTelemetry** → `./docs/TELEMETRY.md`
- **内部实现与贡献/排查 bug** → `./docs/ARCHITECTURE.md`
- **升级改动与迁移** → `./docs/MIGRATION.md` + `./docs/CHANGELOG.md`
- **安全策略（一般仅需要链接/流程）** → `./docs/SECURITY.md`
- **Cursor/编辑器规则（如果你用 Cursor）** → `./docs/CLAUDE.md`

## 在本仓库里 Ax 相关的落点（快速跳代码）

- Univer loopback 总览：`../AI_LOOPBACK.md`
- Headless 执行器入口（Ax loopback）：`../univer-headless/src/ai/ax.ts`
- Loopback 插件（HTTP/RPC 入口）：`../pluxel-plugin-univer-loopback/src/index.ts`
