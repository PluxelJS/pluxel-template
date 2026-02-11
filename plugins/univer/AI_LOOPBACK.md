# Univer AI Loopback 设计与运行机制（前后端）

本文档聚焦 **Univer AI loopback** 这一条链路：从前端 UI 选区/情境/写入范围，到后端 headless 执行、工具调用、快照提交与可观测性。
目标是 **提升 LLM 完成任务的准确率**、**减少往返**、并让行为 **可解释/可追踪/可 debug**。

> 约定：本文所说 “loopback” 指「后端在 headless Univer 上执行工具调用 → 产出新 snapshot → 原子提交到 workbooks store → 前端刷新」。

---

## 1. 关键目标与设计取舍

### 1.1 以准确率为主：避免“猜”

- **强制读后写**：system prompt 强调 *“Do not guess cell values”*，并要求写入后必须最小范围回读验证。
- **减少“沉默错误”**：sheet 解析严格化（找不到 sheetId/sheetName 直接报错），避免写到错误 sheet 但表面成功。
- **工具输入可纠错**：工具错误不直接让一次 generate 崩溃，而是返回 `{ ok:false, error, hint }`，模型可基于 hint 自我修正重试。

### 1.2 减少往返：把常见信息放在一开始、把操作批量化

- **Context pack（预取）**：后端在进入 Ax 前，先读取 `current + readScopes` 的 “左上角预览” 拼进 system prompt，让模型在第一轮就有数据上下文，减少首轮 read 工具调用。
- **Batch tools**：提供 `get_ranges_data` / `set_ranges_data`，让多个不连续范围的读写尽量“一次 call 搞定”。
- **工具索引 + presets**：system prompt 内包含工具索引（按 group/preset 展示），让模型“规划时就知道有哪些工具/预设可选”，减少“问一次/查一次”的往返。

### 1.3 UX 不打断：写范围限制做成显式操作 + 可视化

- **默认整表可写**：写范围限制不是硬阻断，而是“可编辑范围提示 + 可撤销”，避免频繁被 scope 限制打断模型思路。
- **需要时再限制**：用户可通过右键菜单或面板按钮把写范围切到“限制为选区 / 添加选区 / 恢复整表”。
- **读/写范围高亮**：用不同颜色高亮 AI 情境/写入限制，把会话的约束可视化（当前选区保持 Univer 默认高亮）。

---

## 2. 组件与数据流总览

### 2.1 组件划分

- 前端：`plugins/univer/univer-web`
  - 编辑器页：`src/ui/pages/editor-page.tsx`
  - Univer runtime：`src/ui/univer/runtime.ts`
  - AI 浮窗/面板：`src/ui/ai/*`
  - 右键菜单入口：`src/ui/univer/ai-menu.ts`
- 协议 + headless：`plugins/univer/univer-headless`
  - loopback 执行器：`src/ai/ax.ts`
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
   - “写入范围：限制为选区/添加选区/恢复整表”。
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
  - `readScopes` 会包含 `current`（用于后端 context pack/工具默认 sheet），但 `contexts.selections` 只包含“显式添加的情境”。

### 3.2 情境（pinned selections）是全局共享状态

为了让 **右键菜单** 和 **浮窗面板** 操作同一份上下文，情境存进外部 store：

- store：`plugins/univer/univer-web/src/ui/ai/context-store.ts`
- 右键“添加到 AI 情境”（支持 Ctrl 多选）：
  - 采集 active range list → 追加到 store
  - 打开 AI 浮窗
  - `plugins/univer/univer-web/src/ui/univer/ai-menu.ts`

### 3.3 写入范围（write scope）同样做成共享状态

- store：`plugins/univer/univer-web/src/ui/ai/write-scope-store.ts`
- 右键菜单动作：`plugins/univer/univer-web/src/ui/univer/ai-menu.ts`
  - `写入范围：限制为选区`（覆盖为当前+多选）
  - `写入范围：添加选区`（追加）
  - `写入范围：恢复整表`

> 注意：前端的“写入范围”会作为 loopback input 的 `scopes.write` 发送给后端，但后端把它视为 **提示**（见 4.3）。

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
   - `wrapFetchWithLogging()` 记录 LLM 请求/响应（header 脱敏、body 截断）
5. **headless 执行 + 提交**：
   - `runUniverAxLoopback()` 产出修改后的 snapshot
   - 若 snapshot 未变化 → 返回 no-op（不 bump rev）
   - 否则 `commitSnapshot({ baseRev, json })` 原子提交

### 4.3 headless 执行器：如何拉高准确率

入口：`plugins/univer/univer-headless/src/ai/ax.ts`

#### (A) system prompt 的结构化“政策”

`runUniverAxLoopback()` 拼接的 system prompt 会明确：

- **工具使用纪律**：必须用工具读值，不可猜
- **完成即停**：任务完成并验证后立即停止（`maxSteps` 只是安全上限）
- **工具错误处理**：工具可能返回 `{ok:false,error,hint}`，应使用 hint 修正后重试
- **读写策略**：
  - 读：允许读 readScopes 所在 sheet；跨 sheet 读取需在 readScopes 里
  - 写：写后必须回读验证
- **公式策略**：
  - 优先 `fill_formula`（按 cell 自动平移相对引用）
  - 避免 `auto_fill` 用在公式（它只做值重复）
- **批量策略**：
  - 优先 `get_ranges_data / set_ranges_data` 减少往返
  - `get_ranges_data` 返回 `order + byA1`（用 order 遍历，byA1 查值）

#### (B) Context pack：减少首轮 read 往返

在进入 Ax 生成前，后端会为 `current + readScopes` 构建 “左上角预览” 文本：

- 若前端已经传了 `contexts.selections[].selection.display`，优先用它（已按 limits 截断）。
- 不足时再用 `univer.readRangeDisplay` 读一小块补齐。

这一段直接放进 system prompt，模型更容易在第一轮规划时就知道表格大概长什么样。

#### (C) Read scope：同 sheet 放开，跨 sheet 保持约束

后端 read 校验（`checkReadRange`）优先使用 **sheet allow-list**，这比 range 级别更符合真实使用：

- 同一个 sheet 内允许读取任意范围（减少“读超范围就失败”的打断）
- 跨 sheet 的读取仍要求 sheet 在 readScopes 白名单里

见：`plugins/univer/univer-headless/src/ai/ax.ts`（`checkReadRange`）

#### (D) Write scope：仅提示，不做硬拦截（避免打断）

`checkWriteRange/checkWriteCell/checkWriteSheet` 在当前实现里是 no-op：

- `plugins/univer/univer-headless/src/ai/ax.ts`

写入范围会作为 **“Editable ranges (user review)”** 出现在 system prompt 中，让模型自律在范围内写，并由前端可撤销能力兜底。

#### (E) 合约限制：防止 runaway edits

后端对每次 loopback 有 contract 限制（默认值见 `UNIVER_AI_DEFAULT_CONTRACT_LIMITS`）：

- `maxChanges`：写入/清理的“变更次数”上限
- `maxOps`：写入的 cell ops 上限（避免一次刷几万格）

工具在写入前会 `checkCanChange()` / `checkCanApplyOps()`，超限直接错误 + hint。

#### (F) 工具层面的“可纠错”与输入防崩

1) 工具 wrapper（`wrapAxTool`）：

- 捕获异常 → 返回 `{ ok:false, error, hint }`
- 对 input/output 做摘要化日志（避免 values/大矩阵刷爆日志）
- 常见错误提供定向 hint：sheet 不存在、A1 非法、matrix 尺寸错误、越权读取、regex 错误等

见：`plugins/univer/univer-headless/src/ai/ax.ts`

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

---

## 5. Loopback 输入/输出与“hint”语义

### 5.1 前端发给后端的核心输入

前端发送 `UniverLoopbackRunInput`（来自 `@pluxel/univer-headless/protocol`），关键字段：

- `instruction`：用户自然语言指令
- `scopes.read`：A1 列表（仅来自 pinned selections；避免把“当前选区”隐式发送）
- `scopes.write`：A1 列表（整表或限制范围；作为提示）
- `scopes.current`：默认范围（用于默认 sheet 推断与 context pack；取 pinned selections 的第一个）
- `contexts.selections`：仅包含“显式添加的情境 selection”，携带 `display` 预览矩阵
- `maxRounds`：映射到 Ax `maxSteps`（安全上限；模型可提前结束）
- `mode`：`safe | aggressive`
- `limits`：前端/后端用来裁剪预览（默认 40x16）
- `contract/toolPolicy`：可选，细粒度控制工具/合约

### 5.2 工具错误返回的 hint

当前工具层约定：

- 正常返回原本类型（如 `{ updatedCells }`）
- 异常返回：
  - `{ ok:false, error:string, hint:string }`

模型应将 hint 作为“下一步纠错提示”（例如补 sheetId、修复 A1、补齐 matrix、改用 batch 工具等）。

---

## 6. Debug 与可观测性（端到端）

### 6.1 服务端（loopback 插件）日志

每次 run 都带 `runId + workbookId`，并记录：

- start：baseRev、mode、maxRounds、scopes、limits、toolPolicy、instructionPreview
- llm resolved：profile 概览
- llm fetch request/response：脱敏 headers + 截断 body/response preview
- ok/no-op/committed/conflict：rev 变化、rounds、appliedOps、耗时 ms

文件：`plugins/univer/pluxel-plugin-univer-loopback/src/index.ts`

### 6.2 headless（Ax + tools）日志

`runUniverAxLoopback()` 会记录：

- system prompt preview（截断）
- tool groups + tool index mode
- context pack preview（截断）
- 每次 tool call/ok/failed（payload 摘要化）

文件：`plugins/univer/univer-headless/src/ai/ax.ts`

---

## 7. 实际使用建议（为了准确且少往返）

1) **先把相关范围“添加到 AI 情境”**（右键支持 Ctrl 多选），让模型第一轮就有上下文。
2) 若任务需要“读一片写另一片”，保持写范围为整表即可；若确实需要安全边界，再用右键限制写范围。
3) 让模型写入后“回读验证”，并在指令里明确需要验证的输出范围（例如“写完后读回 G2:G12 确认”）。
4) 多块范围读写优先让模型使用 `get_ranges_data` / `set_ranges_data`。
5) 批量公式优先 `fill_formula`，并用 `$` 锁定不该平移的引用。
