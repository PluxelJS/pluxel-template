# Univer AI Loopback 设计与运行机制（前后端）

本文档聚焦 **Univer AI loopback** 这一条链路：从前端 UI 选区/情境/写入范围，到后端 headless 执行、工具调用、快照提交与可观测性。
目标是 **提升 LLM 完成任务的准确率**、**减少工具调用往返**、并让行为 **可解释/可追踪/可 debug**。

> 约定：本文所说 “loopback” 指「后端在 headless Univer 上执行工具调用 → 产出新 snapshot → 原子提交到 workbooks store → 前端刷新」。
>
> Ax（`@ax-llm/ax`）文档导读（常用优先）：[plugins/univer/ax-llm/README.md](./ax-llm/README.md)

---

## 1. 关键目标与设计取舍

### 1.1 以准确率为主：避免“猜”

- **强制读后写**：system prompt 强调 *“Do not guess cell values”*，并要求写入后必须最小范围回读验证。
- **减少“沉默错误”**：sheet 解析严格化（找不到 sheetId/sheetName 直接报错），避免写到错误 sheet 但表面成功。
- **工具输入可纠错**：工具错误统一抛出 `AxFunctionError`（错误消息里包含 `Hint:`），Ax 会把错误上下文喂回模型，促使它修正 tool args 并重试。
- **A1 唯一性**：工具层要求 A1 必须带 sheet（`Sheet!A1:B10`），禁止使用裸 A1（如 `A1:B10`），避免默认 sheet 歧义导致读/写错表。

### 1.2 减少往返：把常见信息放在一开始、把操作批量化

- **Context pack（预取）**：后端在进入 Ax 前，优先使用 `contexts.selections` 的预览矩阵拼进 system prompt；不足时才回退到对 `current/readScopes` 做小范围预览读取，让模型第一轮就有数据上下文，减少首轮 read 工具调用。
- **Batch tools**：提供 `get_ranges_data` / `set_ranges_data`，让多个不连续范围的读写尽量“一次 call 搞定”；所有关键写工具都支持可选 `readback`（写后回读验证），进一步减少“写→读验证”的往返。
- **工具索引 + presets**：system prompt 内包含工具索引（按 group/preset 展示），让模型“规划时就知道有哪些工具/预设可选”，减少“问一次/查一次”的往返。

### 1.3 以准确率为主：写范围硬限制 + 可解释

- **写范围硬限制**：后端严格拒绝任何 out-of-scope 写入（避免写错 sheet/写错范围）。
- **显式扩大 scope**：若指令要求编辑范围外内容，模型应停止并请求用户扩大 `readScopes/writeScopes`。
- **可解释**：工具报错会返回 allowed scopes/sheets 提示，模型可据此自修复或引导用户扩权。

---

## 2. 组件与数据流总览

### 2.1 组件划分

- 前端：`plugins/univer/univer-web`
  - 编辑器页：`src/ui/pages/editor-page.tsx`
  - Univer runtime：`src/ui/univer/runtime.ts`
  - AI 浮窗/面板：`src/ui/ai/*`
  - 右键菜单入口：`src/ui/univer/ai-menu.ts`
- 协议 + headless：`plugins/univer/univer-headless`
  - loopback 执行器：`src/ai/loopback/kernel.ts`（入口 re-export：`src/ai/ax.ts`）
  - MCP 工具实现：`src/ai/mcp/*`
  - A1 解析/格式：`src/ai/a1.ts`
- 后端插件：`plugins/univer/pluxel-plugin-univer-loopback`
  - HTTP：`src/loopback.http.ts`
  - 主逻辑：`src/index.ts`
- 数据存储：`plugins/univer/pluxel-plugin-univer-workbooks`

### 2.2 请求链路（时序）

1. 前端用户在表格里选区（可 Ctrl 多选）。
2. 用户右键：
   - “添加到 AI 情境”（把当前/多选范围作为上下文 selection），或
   - “读取范围：限制为选区/恢复整表”（可选；默认整表可读），或
   - “写入权限：只读/允许整表/限制为选区”（可选；默认只读）。
3. AI 面板发送请求（HTTP）：
   - `POST /api/univer/loopback/run`（默认 5 分钟超时，适配长耗时 LLM 任务）。
4. 后端 loopback 插件：
   - 加载 snapshot → headless Univer 执行 Ax tool-call loop → 得到新 snapshot。
   - 通过 workbooks store 原子提交新 rev（冲突则返回 conflict）。
5. 前端收到结果：
   - 若提交成功且 rev 变化 → `onReloadLatest()` 刷新编辑器快照。

---

## 3. 前端：选区、情境、写入范围与高亮

### 3.1 不自动采集“当前选区”（避免卡顿与隐式上下文）

浮窗不再持续采集/刷新“当前选区”（避免选区移动时频繁读取矩阵导致卡顿）。
上下文只来自用户 **显式** 右键添加到 AI 情境的选区，因此不会出现“我只是点了一下就被当成上下文发送”的隐式行为。

- 选区采集：`plugins/univer/univer-web/src/ui/ai/univer-bridge.ts`
- 面板控制器：`plugins/univer/univer-web/src/ui/ai/panel/controller.ts`
  - “添加到 AI 情境”只影响 `contexts.selections`（用于首轮 prompt 的 context pack），不会自动收紧 `readScopes`。

### 3.2 情境（pinned selections）是全局共享状态

为了让 **右键菜单** 和 **浮窗面板** 操作同一份上下文，情境存进外部 store：

- store：`plugins/univer/univer-web/src/ui/ai/context-store.ts`
- 右键“添加到 AI 情境”（支持 Ctrl 多选）：
  - 采集 active range list → 追加到 store
  - 打开 AI 浮窗
  - `plugins/univer/univer-web/src/ui/univer/ai-menu.ts`

### 3.3 读取范围（read scope）/写入权限（write scope）独立管理

为了让模型“默认更实用”，并避免把“上下文选择”误当作权限，本实现把：
- **情境（context）**：只用于 prompt（context pack）
- **读取范围（read scope）**：决定工具允许读取的范围（默认整表）
- **写入权限（write scope）**：决定工具允许写入的范围（默认只读）

分别做成 store，由右键菜单显式控制。

读取范围（read scope）：

- store：`plugins/univer/univer-web/src/ui/ai/read-scope-store.ts`
- 右键菜单动作：`plugins/univer/univer-web/src/ui/univer/ai-menu.ts`
  - `读取范围：限制为选区`
  - `读取范围：添加选区`（可在不同工作表重复执行，累积跨表读取授权）
  - `读取范围：恢复整表`
  - `读取范围：恢复工作簿`（允许读取整个工作簿所有工作表）

写入权限（write scope）：

- store：`plugins/univer/univer-web/src/ui/ai/write-scope-store.ts`
- 右键菜单动作：`plugins/univer/univer-web/src/ui/univer/ai-menu.ts`
  - `写入权限：只读（关闭写入）`
  - `写入权限：允许整表`
  - `写入权限：允许工作簿`（允许写入整个工作簿所有工作表；高风险）
  - `写入权限：限制为选区`
  - `写入权限：添加选区`（可在不同工作表重复执行，累积跨表写入授权）

### 3.4 选区自动刷新（解决“不会自动刷新”）

面板订阅 `FWorkbook.onSelectionChange`，selection move end 时节流刷新（避免频繁重渲染）：

- `plugins/univer/univer-web/src/ui/ai/panel/controller.ts`

### 3.5 读/写范围可视化（不同颜色高亮）

为减少误操作、提升“可解释性”，面板打开时会把本次会话的范围高亮出来：

- **紫色**：AI 情境（会预取/会发送）
- **橙色**：写入限制（仅“限制”模式时显示）

实现点：

- overlay 支持批量高亮：`plugins/univer/univer-web/src/ui/univer/overlay.ts`
  - `setHighlights({ items })`：多块范围同时 highlight
- runtime 暴露 API：`plugins/univer/univer-web/src/ui/univer/runtime.ts`
  - `setOverlayHighlights()` / `clearOverlay()`
- 面板驱动 overlay：`plugins/univer/univer-web/src/ui/ai/panel/controller.ts`

---

## 4. 后端：loopback 插件与 headless 执行器

### 4.1 HTTP 与 RPC：为什么默认走 HTTP

LLM 工具调用任务经常 >20s。为避免 RPC 客户端短超时：

- 后端提供 HTTP：`POST /api/univer/loopback/run`
  - `plugins/univer/pluxel-plugin-univer-loopback/src/loopback.http.ts`
- 前端默认用 HTTP backend，超时 5 分钟：
  - `plugins/univer/univer-web/src/ui/ai/loopback-http.ts`

RPC 仍保留用于开发/短任务（同一个 handler 逻辑）。

### 4.2 loopback 插件（服务端）职责

核心行为（`plugins/univer/pluxel-plugin-univer-loopback/src/index.ts`）：

1. **串行化执行**：headless Univer engine 复用，避免并发互相污染 → 用 promise 链 `this.seq` 串行。
2. **快照读取 + 冲突处理**：
   - `baseRev` 不等于 `latestRev` → 直接返回 conflict（提示前端刷新）
3. **LLM 连接解析**：
   - 通过 `pluxel-plugin-llm-hub` 解析 profile（可指定 `llmProfileId`）
4. **对外可观测性**：
   - `wrapFetchWithOtel()` 产出 `univer.ax.fetch` span（HTTP attrs + duration；URL 去掉 query/fragment）
   - 整个请求运行在 `univer.loopback.request` root span 下（runId/workbookId/baseRev/scopes/llmProfileId/instructionPreview 等 attributes）
5. **headless 执行 + 提交**：
   - `runUniverAxLoopback()` 产出修改后的 snapshot
   - 若 snapshot 未变化 → 返回 no-op（不 bump rev）
   - 否则 `commitSnapshot({ baseRev, json })` 原子提交

### 4.3 headless 执行器：如何拉高准确率

入口（re-export）：`plugins/univer/univer-headless/src/ai/ax.ts`  
实现：`plugins/univer/univer-headless/src/ai/loopback/kernel.ts`

代码结构（建议从入口往里读）：
- `plugins/univer/univer-headless/src/ai/loopback/kernel.ts`：组装/编排（按 phases orchestrate）
- `plugins/univer/univer-headless/src/ai/loopback/attempt-flow.ts`：AxFlow feedback loop（Editor + QA）
- `plugins/univer/univer-headless/src/ai/loopback/programs.ts`：Editor/QA agent signatures & programs
- `plugins/univer/univer-headless/src/ai/loopback/tools.ts` + `tool-wrap.ts`：工具组装/封装（含 hint + OTel）

#### (0) AxFlow：迭代/反馈回路（Iterative Processing）

执行器使用 **AxFlow 的 while/feedback 能力**把一次 loopback 拆成“多次 attempt”：

- 典型触发重试：**写后未回读验证**、本轮出现工具错误且模型宣称已完成
- 额外加入 **DSPy 风格的 “Editor + QA Evaluator” 分离**：当模型宣称 done 且满足基本不变量时，会运行一个严格 QA（可用 *只读工具* 做最小 spot-check），低置信度则反馈重试
- 执行策略由后端固定（不暴露前端 knobs）：
  - `maxAttempts=2`
  - `maxStepsPerAttempt=40`（默认；可能按任务轻微上调）
  - `maxStepsTotal=80`（默认硬上限；可能按任务轻微上调，或用环境变量覆盖）
- 每次 attempt 都会产出结构化 **span events + metrics**（attempt、steps 上限、读写/错误/验证状态），确保链路 **可观测**

#### (A) system prompt 的结构化“政策”

`runUniverAxLoopback()` 拼接的 system prompt 会明确：

- **工具使用纪律**：必须用工具读值，不可猜
- **完成即停**：任务完成并验证后立即停止（`maxSteps` 只是安全上限）
- **工具错误处理**：工具调用失败会通过 Ax 的 **function error** 反馈给模型；错误信息里若包含 `Hint:`，应优先按提示修正参数并重试
- **读写策略**：
  - 读：只允许读 `readScopes` 提供的 A1 范围内（range-within-scope；同 sheet 也不会自动放开）
  - 写：只允许写 `writeScopes` 范围内；写后必须回读验证（可用“写工具 + readback”在同一次 call 完成验证）
- **公式策略**：
  - 优先 `fill_formula`（按 cell 自动平移相对引用）
  - 避免 `auto_fill` 用在公式（它只做值重复）
- **批量策略**：
  - 优先 `get_ranges_data / set_ranges_data` 减少往返
  - `get_ranges_data` 返回 `order + byA1`（用 order 遍历，byA1 查值）

#### (B) Context pack：减少首轮 read 往返

在进入 Ax 生成前，后端会为 `current + readScopes` 构建 “左上角预览” 文本：

- 若前端已经传了 `contexts.selections[].selection.display`，优先用它（已按 limits 截断）。
- 不足时再用后端 `readRangeDisplay` helper 读一小块补齐（带 scope 校验 + 读缓存）。

这一段直接放进 system prompt，模型更容易在第一轮规划时就知道表格大概长什么样。

#### (C) Read scope：严格按 A1 scope 校验

后端 read 校验（`checkReadRange`）是**严格的 range-within-scope**：

- 只能读取 `readScopes` 提供的 A1 范围内（同 sheet 也不会“全放开”）
- 跨 sheet 的读取必须在 `readScopes` 中显式提供该 sheet 的 scope
- 读超范围会直接报错，并在错误消息中附带 allowed scopes/sheets（便于模型自修复）

见：`plugins/univer/univer-headless/src/ai/loopback/tools.ts`（`checkReadRange`）

#### (D) Write scope：严格按 A1 scope 校验

`checkWriteRange/checkWriteCell/checkWriteSheet` 在当前实现里是**硬校验**：

- `plugins/univer/univer-headless/src/ai/loopback/tools.ts`

写入范围也会作为 **“Write scope (user review)”** 出现在 system prompt 中，但后端同样会拒绝任何 out-of-scope 写入，避免“写错表/写错范围”。

#### (E) 合约限制：防止 runaway edits

后端对每次 loopback 有 contract 限制（默认值见 `UNIVER_AI_DEFAULT_CONTRACT_LIMITS`）：

- `maxChanges`：写入/清理的“变更次数”上限
- `maxOps`：写入的 cell ops 上限（避免一次刷几万格）

工具在写入前会 `checkCanChange()` / `checkCanApplyOps()`，超限直接错误 + hint。

#### (F) 工具层面的“可纠错”与输入防崩

1) 工具 wrapper（`wrapAxTool`）：

- 捕获异常 → 通过 Ax 的 **function error** 机制返回给模型（错误信息里包含 `Hint:` 时应优先遵循）
- 对 input/output 做摘要化 **span attributes**（避免 values/大矩阵刷爆 telemetry）
- 常见错误提供定向 hint：sheet 不存在、A1 非法、matrix 尺寸错误、越权读取、regex 错误等

见：`plugins/univer/univer-headless/src/ai/loopback/tool-wrap.ts`

2) sheet 解析严格化（避免写错 sheet）：

- `resolveSheet()`：如果显式传了 sheetId/sheetName 但找不到，会直接抛错
- `plugins/univer/univer-headless/src/ai/mcp/utils.ts`

3) 写入矩阵尺寸校验（避免 Univer 内部崩溃）：

- `set_range_data` / `set_ranges_data` 要求 dense matrix 且尺寸匹配 range（rows x cols）
- `plugins/univer/univer-headless/src/ai/mcp/data.ts`

#### (G) Batch tools：减少往返且保持“信息不重复”

`get_ranges_data` 返回：

```ts
{ order: string[], byA1: Record<string, GetRangeResult> }
```

- `order` 提供稳定遍历顺序（去重）
- `byA1` 便于按 key 随机访问
- 不再返回重复的 `items + byA1`，减少 prompt/响应冗余

实现：`plugins/univer/univer-headless/src/ai/mcp/data.ts`

#### (H) fill_formula：提升公式编辑正确性

`fill_formula` 接收一个 base formula（必须以 `=` 开头），按 cell 偏移对相对引用做平移：

- “要锁定行/列就用 `$`” 的规则写进 hint，便于模型在失败时自修复。

实现：`plugins/univer/univer-headless/src/ai/mcp/data.ts`

#### (I) 写后回读（readback）：减少往返但不放松校验

以下写工具都支持可选 `readback`（在同一次 tool-call 内“写入 → 回读验证”）：

- `set_range_data`
- `set_ranges_data`
- `auto_fill`
- `fill_formula`

`readback` 结果统一返回：

```ts
{ order: string[], byA1: Record<string, GetRangeResult> }
```

- `order`：稳定遍历顺序（去重后）
- `byA1`：按 A1 精确取值（更利于模型 follow-up）
- `readback` 本质仍是读操作：同样受 `readScopes` 的严格范围限制

---

## 5. Loopback 输入/输出与“hint”语义

### 5.1 前端发给后端的核心输入

前端发送 `UniverLoopbackRunInput`（来自 `@pluxel/univer-headless/protocol`），关键字段：

- `instruction`：用户自然语言指令
- `scopes.read`：A1 列表（读取权限范围；默认整表可读；可通过右键“读取范围：限制为选区”显式收紧）
- `scopes.write`：A1 列表（写入权限范围；默认只读不下发 writeScopes；一旦下发则 **后端硬限制**，out-of-scope 写入会被拒绝）
- `scopes.current`：默认范围（用于默认 sheet 推断与 tool 的默认 sheet；当前实现使用“当前工作表整表 A1”）
- `contexts.selections`：仅包含“显式添加的情境 selection”，携带 `display` 预览矩阵
- Loopback 运行策略由后端固定（不暴露前端 knobs），并始终启用严格的“写后验证”纪律；QA 默认按需触发（可通过环境变量关闭）
- 预览/读取裁剪由后端控制（默认 40x16；对“数据清洗/汇总”等场景会自动放大到 80x24），前端的 `contexts.selections[].selection.display` 仍会被优先利用以减少首轮 reads

### 5.2 工具错误返回的 hint

当前工具层约定：

- 正常返回原本类型（如 `{ updatedCells }` / `{ order, byA1 }` / `{ readback }`）。
- 异常通过 Ax 的 **function error** 机制抛出 `AxFunctionError`：
  - message 中会包含可读错误信息
  - 若可推断纠错方向，会附加一行 `Hint: ...`
  - field 会尽量指向最可能出错的参数路径（便于模型修正 args 并重试）

模型应将 `Hint:` 视为“下一步纠错提示”（例如补 sheetId、修复 A1、补齐 matrix、改用 batch 工具等）。

---

## 6. Debug 与可观测性（端到端）

启用采集：依赖 `pluxel-plugin-otlp`（OTLP/HTTP exporter）。在 host 配置中打开 traces/metrics（建议关 logs）：

```ts
host.cfg('OtlpHub').set({
  exporting: { mode: 'push', push: { endpoint: 'http://localhost:4318' } },
  signals: { traces: true, metrics: true, logs: false },
})
```

生产建议走 `OtlpHub -> OpenTelemetry Collector / Grafana Alloy -> 你的后端/DB`；本插件当前导出的是 **OTLP/HTTP JSON**。

### 6.1 服务端（loopback 插件）OpenTelemetry

每次 run 都带 `runId + workbookId`，并通过 traces/metrics 记录：

- root span：`univer.loopback.request`（关键 attributes）：
  - `univer.run_id`、`univer.workbook_id`、`univer.base_rev`
  - `univer.llm_profile_id`、`univer.instruction.preview`
  - `univer.scopes.read.count`、`univer.scopes.write.count`、`univer.scopes.current`
  - `llm.provider`、`llm.model`
  - `ax.flow`（= `univer.loopback`）、`ax.purpose`（= `loopback`）
  - `univer.rounds`、`univer.applied_ops`、`univer.conflict`、`univer.request.duration_ms`
- 子 spans：`univer.llm.connection`、`univer.ax.fetch`（URL 去掉 query/fragment；`http.*` attrs + duration/status）、`univer.headless.loopback`

文件：`plugins/univer/pluxel-plugin-univer-loopback/src/index.ts`

本地开发推荐启用 `pluxel-plugin-otlp-viewer`，打开 `/otlp`，用结构化过滤查看：
- `attr.ax.flow = univer.loopback`
- `name contains univer.ax.fetch`

### 6.2 headless（Ax + tools）OpenTelemetry

`runUniverAxLoopback()` 会记录（traces + metrics）：

- root span：`univer.loopback`（关键 attributes）：
  - `univer.max_steps_total`、`univer.max_attempts`、`univer.max_steps_per_attempt`
  - `univer.tools.count`、`univer.tool_index_mode`、`univer.groups`
  - `univer.read_scopes.count`、`univer.write_scopes.count`
- attempt events：`univer.attempt`（attempt/maxAttempts、toolCallsDelta、errorsDelta、wrote/verified/hadErrors、QA 置信度等）
- Ax step events：`ax.functions`（近几次 function calls、usage total tokens）
- 每次工具调用 span：`univer.tool`（tool name/kind/seq、duration、input/output summary）
- metrics：
  - `univer.tool.calls` / `univer.tool.errors`
  - `univer.tool.latency_ms`
  - `univer.loopback.attempts`

文件：`plugins/univer/univer-headless/src/ai/ax.ts`
（实现见：`plugins/univer/univer-headless/src/ai/loopback/kernel.ts` + `plugins/univer/univer-headless/src/ai/loopback/tool-wrap.ts`）

---

## 7. 实际使用建议（为了准确且少往返）

1) **先把相关范围“添加到 AI 情境”**（右键支持 Ctrl 多选），让模型第一轮就有上下文。
2) 若任务需要“读一片写另一片”，保持写范围为整表即可；若确实需要安全边界，再用右键限制写范围。
3) 让模型写入后“回读验证”，并在指令里明确需要验证的输出范围（例如“写完后读回 G2:G12 确认”）。
4) 多块范围读写优先让模型使用 `get_ranges_data` / `set_ranges_data`。
5) 批量公式优先 `fill_formula`，并用 `$` 锁定不该平移的引用。
