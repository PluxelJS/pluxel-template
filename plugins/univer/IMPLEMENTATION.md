# Univer 项目运行与机制说明（当前实现）

本文档描述本仓库里 **Univer 子系统** 的整体运作方式与关键机制。
仓库本身是 Pluxel 工作区（含插件/前端/服务），Univer 作为其中一个业务域，
通过 RPC/SSE/HTTP 与主运行时协作。本文面向维护/扩展，
尽量覆盖从后端存储、协议、前端运行时到 AI loopback 的完整路径。

目录
- 1. 系统分层与主要组件
- 2. 运行时总流程（从打开到保存）
- 3. Univer 核心服务插件（SSE + capabilities）
- 4. Workbooks 服务（存储、HTTP、RPC）
- 5. Frontend（univer-web）运行时
- 6. Headless + AI loopback 机制
- 7. MCP 工具组与选择策略
- 8. 扩展点与常见改动位置
- 附：AI loopback 专项文档（更详细）

---

> AI loopback 相关的前后端细节（情境/写入范围/高亮/批量工具/hint/可观测性等）已拆到独立文档：
> `plugins/univer/AI_LOOPBACK.md`
>
> Ax（`@ax-llm/ax`）上游文档较多，这里有一份按开发时常用程度整理的导读：
> [plugins/univer/ax-llm/README.md](./ax-llm/README.md)

## 1. 系统分层与主要组件

Univer 子系统在本仓库中分为四块：

1) **pluxel-plugin-univer**  
   核心服务插件，负责：
   - 维护“前端插件 spec”集合（可序列化配置）
   - 通过 SSE 推送给前端
   - 汇总 capability providers，暴露统一 RPC (`UniverRpc`)

2) **pluxel-plugin-univer-workbooks**  
   工作簿数据服务，负责：
   - SignalDB 存储元信息/快照/上传
   - HTTP 数据面（快照读取、上传）
   - RPC 控制面（列出/创建/保存/提交）

3) **pluxel-plugin-univer-ai**  
   Univer AI 能力插件，负责：
   - 通过 `pluxel-plugin-llm-hub` 判断“是否有可用 LLM profile”
   - 将结果作为 capability (`UNIVER_CAP_AI`) 提供给 `pluxel-plugin-univer`

4) **pluxel-plugin-univer-loopback**  
   Univer loopback 执行插件，负责：
   - RPC `UniverLoopback.runLoopback()`
   - 解析快照 → headless Univer 执行 → 产出新快照
   - 通过 `UniverWorkbooksStore.commitSnapshot()` 原子提交新 rev
   - LLM 调用通过 `pluxel-plugin-llm-hub` + Ax adapter 完成（后端真实调用点）

5) **@pluxel/univer-headless**  
   共享 headless + 协议包，负责：
   - `protocol/*`：SSE/RPC/AI/工具类型定义
   - Headless AI bridge + MCP 工具
   - Ax loopback 执行器（tool-call)

6) **univer-web**  
   前端运行时和 UI，包括：
   - Univer 运行时封装（创建/卸载/聚焦/水印/高亮）
   - 编辑器页（保存流程、插件安装、AI 面板）
   - AI 面板（选区上下文、loopback 调用）

目录结构（关键路径）：
```
plugins/univer
  pluxel-plugin-univer/
  pluxel-plugin-univer-ai/
  pluxel-plugin-univer-loopback/
  pluxel-plugin-univer-workbooks/
  univer-headless/
    src/protocol/...
    src/ai/...
  univer-web/
    src/ui/pages/editor-page.tsx
    src/ui/univer/runtime.ts
    src/ui/ai/...
```

---

## 2. 运行时总流程（从打开到保存）

1) **打开工作簿**
   - 前端 `univer-web` 通过 `UniverWorkbooks` RPC 调 `openWorkbook(id)` 获取元信息
     (最新 rev, etag, snapshot URL, autosave policy 等)
   - 通过 HTTP `GET /api/univer/workbooks/:id/snapshots/:rev` 拉取快照 JSON
   - `createUniverRuntime()` 使用快照创建 Univer 实例并挂载 UI

2) **插件注入**
   - `pluxel-plugin-univer` 通过 SSE (`univer:plugins`) 推送插件 specs
   - 前端解析 snapshot/upsert/remove，按 `spec.key` 去重，生成 effective plugins
   - 运行时根据 `key` 安装前端插件（如 watermark）

3) **编辑与保存**
   - 前端监听编辑状态，依据 autosave policy 触发保存
   - 保存流程：
     1. `beginSave({ id, baseRev, sha256, byteSize })` → 返回 `uploadUrl` + `commitToken`
     2. `PUT uploadUrl` 上传快照 JSON
     3. `commitSave({ id, uploadId, commitToken })`
   - 若版本冲突，返回 `currentRev` + `latestSnapshotUrl`，前端提示刷新或处理冲突

---

## 3. Univer 核心服务插件（SSE + capabilities）

文件：`plugins/univer/pluxel-plugin-univer/src/index.ts`

能力：
- **插件 spec 管理**：`use({ key, config })` 注册，生成 `UniverPluginSpec` 并 SSE 推送
- **capabilities 聚合**：`provideCapability(key, provider)` 注册能力提供者
  - 定期缓存 2s，RPC `capabilities()` 返回 `UniverCapabilitiesSnapshot`
  - 前端通过 `UNIVER_CAP_AI` 判断 AI 是否可用
  - `pluxel-plugin-univer-ai` 会把 LLMHub 的可用性映射为 `UNIVER_CAP_AI`
- **内置插件**：默认启用 watermark（可配置）

SSE namespace：`UNIVER_PLUGINS_SSE_NS = 'univer:plugins'`

---

## 4. Workbooks 服务（存储、HTTP、RPC）

文件：`plugins/univer/pluxel-plugin-univer-workbooks/*`

### 4.1 存储
基于 `SignalDB`，主要集合：
- `univer-workbooks`：工作簿元信息（rev/etag/时间）
- `univer-folders`：文件夹
- `univer-snapshots`：快照 JSON（按 rev 存档）
- `univer-uploads`：上传事务

### 4.2 HTTP 数据面
`workbooks.http.ts` 注册 HTTP 路由：
- `GET /api/univer/workbooks/:id/meta`
- `GET /api/univer/workbooks/:id/snapshots/:rev`（带 ETag）
- `PUT /api/univer/workbooks/:id/uploads/:uploadId?token=...`

### 4.3 RPC 控制面
`workbooks.rpc.ts` 提供：
- 浏览/创建/删除文件夹
- 列出/创建/删除工作簿
- `openWorkbook / beginSave / commitSave`

---

## 5. Frontend（univer-web）运行时

### 5.1 创建与销毁
`createUniverRuntime()`：
- new `Univer` + Facade API
- 装载 sheets/ui/engine 插件
- 绑定 focus 与 undo batch
- 注册 AI 菜单入口（若 AI capability 可用）
- 提供 `saveSnapshotJson()` 给保存流程

### 5.2 插件与水印
前端解析 `univer:plugins` SSE：
- 以 `spec.key` 为逻辑唯一键
- 按最新序列号合并
- 对 key 做前端支持过滤（`isSupportedUniverPluginKey`）

### 5.3 保存与冲突
`editor-page.tsx` 负责：
- 维护 dirty/lastEdit 时间
- 按 autosave policy 调度保存
- begin/commit save + 上传快照
- 冲突时提示刷新

---

## 6. Headless + AI loopback 机制

### 6.1 入口与协议
AI loopback 通过：
- HTTP `POST /api/univer/loopback/run`（推荐；避免 RPC 20s 超时）
- 或 RPC `UniverLoopbackRpc.runLoopback()`（开发/短任务）
输入定义：`UniverLoopbackRunInput`（见 `protocol/loopback.ts`）：
```
{
  workbookId,
  baseRev?,
  instruction,
  scopes: { read: string[], write?: string[], current?: string },
  contexts?: { selections: UniverAiContext[] },
  llmProfileId
}
```

后端实现位于 `pluxel-plugin-univer-loopback`：
- 通过 `pluxel-plugin-llm-hub` 解析 profile（可选 `llmProfileId`）
- 使用 `pluxel-plugin-llm-hub/adapters/ax` 构造 `AxAI`
- 在 headless Univer 里执行 tool-call，并通过 `UniverWorkbooksStore.commitSnapshot()` 提交新快照

### 6.2 选区上下文
前端 `univer-bridge.ts` 读取当前选区与 pinned 选区：
- 采样 display values（按 maxRows/maxCols 截断）
- 生成 `UniverAiContext`（包含 `selection`）
AI 面板将 pinned selections 作为 **上下文（context pack）** 发送给后端（`contexts.selections`），用于首轮 prompt 提供“预览矩阵”，减少首轮工具读取。

读取/写入权限不再从 pinned selections 推断，而是独立管理：
- `scopes.read`：读取范围（默认整表；可右键限制为选区）
- `scopes.write`：写入权限（默认只读；需要显式授权才会下发）
> 注：一旦下发 `scopes.write`，后端会对所有写工具做 **硬校验**（out-of-scope 写入直接拒绝）。

### 6.3 Ax loopback 执行
`univer-headless/src/ai/loopback/*`（入口 re-export：`univer-headless/src/ai/ax.ts`）：
- `createUniverAxTools()` 组装工具（MCP 工具）
- read scopes 会做硬校验：**严格按 A1 scope 校验（range-within-scope）**
- write scopes 会做硬校验：**严格按 A1 scope 校验（range-within-scope）**
- 执行器使用 **AxFlow 的 iterative processing / feedback loop** 做“重试”（如：写后未回读验证、工具报错后需补救）
- 当模型宣称已完成且满足基本不变量时，会额外跑一次 **QA evaluator**（DSPy 风格“Editor + Evaluator”分离），必要时用 *只读工具* 做最小验证；低置信度则反馈重试
- Loopback 运行策略由后端固定（不暴露前端 knobs）：
  - `maxAttempts=2`
  - `maxStepsPerAttempt=40`
  - `maxStepsTotal=80`（硬上限）
- 额外做一条硬性可观测规则：若发生写入，则必须在最后一次写入后至少有一次读取（用于“写后验证”纪律）
- `UNIVER_AI_DEFAULT_CONTRACT_LIMITS` 限制 ops/changes
- **Context pack**：优先使用前端随 loopback input 传入的 `contexts.selections[].selection.display`（已截断的预览），
  不足时才回退到后端 `readRangeDisplay` helper（带 scope 校验 + 读缓存）；最终把“左上角预览 TSV”塞进 system prompt，用来减少首轮 read 工具调用与往返。
- **工具错误可恢复**：工具异常会通过 Ax 的 **function error** 机制返回给模型（错误信息中包含 `Hint:` 时应优先遵循），模型应据此修正参数并重试。
- **写后回读优化（可选）**：以下写工具都支持 `readback`，可在同一次 tool-call 内完成 “写入 → 回读验证”，减少往返：
  - `set_range_data` / `set_ranges_data`
  - `auto_fill` / `fill_formula`
  `readback` 统一返回 `{ order, byA1 }`，并且仍受 `readScopes` 的严格范围限制。
- **读缓存（单次 loopback 内）**：对常用读工具（如 `get_range_data` / `search_cells` / `readRangeDisplay` helper）做缓存；
  任意写入（`bumpChange()`）会提升 epoch 并清空缓存，避免读到旧值。
- **limits 自动调优**：后端会根据指令/工具组做轻量扩展，更偏数据清洗/汇总任务时自动放大读窗口。

### 6.4 Prompt/Tool Index
loopback 会把：
 - tool groups
 - tool index（固定按 groups 展示，并附带 presets 映射）
 - editable ranges
 - context pack 预览（若可读到）
拼接为系统描述，引导模型使用工具读取/写入。
Prompt 里也会明确提示“尽量批量编辑，减少 tool-call 次数”。

---

## 7. MCP 工具组

MCP 工具按领域拆分（`univer-headless/src/ai/mcp/*`）：
- core/data/sheet/structure/style

当前实现中，loopback 总是启用所有 MCP 工具组（减少环境分歧、提升可预测性）。

工具目录集中维护在：
`univer-headless/src/ai/mcp/catalog.ts`

---

## 8. 扩展点与常见改动位置

### 8.1 新增前端插件
- `pluxel-plugin-univer` 侧 `use({ key, config })`
- `univer-web` 侧 `isSupportedUniverPluginKey` + `applyFrontendPlugins`

### 8.2 新增 AI 工具
- `univer-headless/src/ai/mcp/*` 增加工具实现
- 更新 `catalog.ts` 的 tool/preset 元数据
- 视需要更新 `protocol/tools.ts` 类型

### 8.3 修改保存策略
- `UniverWorkbooksStore` 内 `DEFAULT_AUTOSAVE_POLICY`
- `univer-web/src/ui/pages/editor-page.tsx` 调度逻辑

### 8.4 调整 AI loopback 行为
- `univer-headless/src/ai/loopback/kernel.ts`
- `univer-headless/src/ai/loopback/tools.ts`
- `univer-headless/src/ai/loopback/tool-wrap.ts`
- `univer-web/src/ui/ai/panel/controller.ts`

---

## 9. 协议文件速查

`plugins/univer/univer-headless/src/protocol/`：
- `primitives.ts`：WorkbookId/SheetId/A1/Range/RangeRef
- `tools.ts`：MCP 工具类型
- `ai.ts`：AI context + legacy tool types + SSE thread events
- `capabilities.ts`：capabilities 快照（`UNIVER_CAP_AI`）
- `plugins.ts`：插件 spec + SSE payload
- `loopback.ts`：loopback 输入/输出
- `rpc.ts`：UniverRpc + UniverLoopbackRpc
- `workbook.ts`：工作簿检查结构

---

如果你希望补充“部署/启动方式”、“接口示例调用”或“主工程（非 Univer）运行流程”，
告诉我你想覆盖的范围，我会在本文档追加相应章节。
