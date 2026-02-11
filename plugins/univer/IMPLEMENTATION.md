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
  instruction,
  scopes: { read: string[], write?: string[], current?: string },
  maxRounds, mode, llmProfileId,
  toolPolicy, limits, contract
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
AI 面板将选区 A1 列表作为 **可编辑范围提示**，并写入 loopback input。

### 6.3 Ax loopback 执行
`univer-headless/src/ai/ax.ts`：
- `createUniverAxTools()` 组装工具（MCP + legacy）
- read scopes 会做硬校验：**按 sheet 白名单**（同 sheet 内允许任意范围读取；跨 sheet 仍需出现在 readScopes）
- write scopes 仅作为 **提示上下文**，不做硬限制
- `maxRounds` 会映射到 Ax 的 `maxSteps`（限制 tool-call iterations；仅作为安全上限，模型应在完成任务后主动停止；默认=硬上限 80，最小允许 1）
- `UNIVER_AI_DEFAULT_CONTRACT_LIMITS` 限制 ops/changes
- **Context pack**：优先使用前端随 loopback input 传入的 `contexts.selections[].selection.display`（已截断的预览），
  不足时才回退到后端工具读取；最终把“左上角预览 TSV”塞进 system prompt，用来减少首轮 read 工具调用与往返。
- **工具错误可恢复**：工具异常会返回 `{ok:false,error,hint}` 给模型，避免直接让一次 forward 崩溃；模型应根据 hint 调整参数重试。
- **读缓存（单次 loopback 内）**：对常用读工具（如 `get_range_data` / `search_cells` / `univer.readRangeDisplay`）做缓存；
  任意写入（`bumpChange()` / `applyOpsV1` / `clearRange`）会提升 epoch 并清空缓存，避免读到旧值。
- **limits 自动调优（可覆盖）**：当 `input.limits` 未显式提供时，后端会根据指令/工具组/模式做轻量扩展，
  更偏数据清洗/汇总任务时自动放大读窗口；显式 `limits` 仍优先。

### 6.4 Prompt/Tool Index
loopback 会把：
 - tool groups
 - tool index（按 `toolPolicy.toolIndex`，未提供时：组数少用 `tools`，组数多用 `groups`；并附带 presets 映射）
 - editable ranges
 - context pack 预览（若可读到）
拼接为系统描述，引导模型使用工具读取/写入。
Prompt 里也会明确提示“尽量批量编辑，减少 tool-call 次数”。

---

## 7. MCP 工具组与选择策略

MCP 工具按领域拆分（`univer-headless/src/ai/mcp/*`）：
- core/data/sheet/structure/style

工具选择逻辑：
1) 前端传 `toolPolicy`（goal + prefer/allow/maxGroups）
2) 后端 `resolveMcpToolGroups()` 计算最小工具组
3) 按策略注入 tool index（groups 或 tools）

工具目录集中维护在：
`univer-headless/src/ai/mcp/catalog.ts`

---

## 8. 扩展点与常见改动位置

### 8.1 新增前端插件
- `pluxel-plugin-univer` 侧 `use({ key, config })`
- `univer-web` 侧 `isSupportedUniverPluginKey` + `applyFrontendPlugins`

### 8.2 新增 AI 工具
- `univer-headless/src/ai/mcp/*` 增加工具实现
- 更新 `catalog.ts`/`selection.ts` 的 tool/preset 元数据
- 视需要更新 `protocol/tools.ts` 类型

### 8.3 修改保存策略
- `UniverWorkbooksStore` 内 `DEFAULT_AUTOSAVE_POLICY`
- `univer-web/src/ui/pages/editor-page.tsx` 调度逻辑

### 8.4 调整 AI loopback 行为
- `univer-headless/src/ai/ax.ts`
- `univer-web/src/ui/ai/panel/controller.ts`

---

## 9. 协议文件速查

`plugins/univer/univer-headless/src/protocol/`：
- `primitives.ts`：WorkbookId/SheetId/A1/Range/RangeRef
- `tools.ts`：MCP 工具与 tool policy
- `ai.ts`：AI context + legacy tool types + SSE thread events
- `capabilities.ts`：capabilities 快照（`UNIVER_CAP_AI`）
- `plugins.ts`：插件 spec + SSE payload
- `loopback.ts`：loopback 输入/输出
- `rpc.ts`：UniverRpc + UniverLoopbackRpc
- `workbook.ts`：工作簿检查结构

---

如果你希望补充“部署/启动方式”、“接口示例调用”或“主工程（非 Univer）运行流程”，
告诉我你想覆盖的范围，我会在本文档追加相应章节。
