# Univer × LLM Hub × TOON：AI 读表/写表（ChangeSet 驱动）设计草案

目标：在现有：

- `pluxel-plugin-univer`（核心前端：编辑器 + `ext.ui` 注入 + UI）
- `pluxel-plugin-univer-workbooks`（service-only：文档/文件夹 + 打开/保存控制面 + snapshot HTTP 数据面）

基础上，引入一个新的 **service-only** 插件 `pluxel-plugin-univer-ai`，对接：

- `pluxel-plugin-llm-hub`（LLM 调用：profiles in pluginData，API keys in Vault）
- `@pluxel/promptkit/toon`（结构化上下文压缩编码）

实现：

- **读表**：从前端收集“用户当前视图/选区”的结构化上下文（TOON 编码，token-efficient）。
- **AI 交互**：后端调用 Ax（密钥/模型配置在 Vault/pluginData），可选 streaming。
- **写表**：AI 输出 **ChangeSet**（结构化变更集），由前端高亮预览、用户选择后，再通过 Univer Facade/Command 应用到工作簿并走保存流程。

> 核心原则：后端不直接改 snapshot；前端只用 Univer command/Facade 写入（符合 `univer/MVP.md` 的硬约束）。

---

## 状态（2026-02-06）

- 已创建并接入 `pluxel-plugin-univer-ai`（service-only）：提供 `UI.rpc.UniverAI.suggestEdits()`，基于 Ax + TOON 输出 ChangeSet（MVP 先支持 `setValues/clear`）。
- 已在核心编辑页接入 AI Panel（右侧 Drawer），支持：选区采样 → 生成建议 → 列表勾选 → 定位高亮 → 批量应用（with undo batching）。
- Overlay 与 transaction 的“底座能力”已在 `pluxel-plugin-univer` 落地（见文末参考与代码链接）。

## 0. 范围与非目标（先明确）

**MVP 范围（本设计优先保证）**：

- 以“选区/可见区域”的小上下文为主（避免全量 workbook 喂给 LLM）
- 先支持 `setValues/clear` 这类最小写入 op
- 先做“预览 + 勾选 + 应用”，不做“自动替用户直接改”

**非目标（先不做，但预留接口）**：

- 不做 server-side OT / 协作 / 自动合并冲突
- 不做后端直接写 snapshot（保持硬约束）
- 不强依赖 Durable Streams（作为后续增强项）

## 1. 现状（已完成的 MVP 基座）

### 1.1 插件边界（当前 repo）

- `pluxel-plugin-univer`
  - 唯一触达 `ext.ui` 的核心插件（tab + standalone editor route）
  - 在浏览器创建 Univer、监听命令事件、触发 autosave
  - 文档管理 UI（文件夹/文件浏览）在 core tab 中
- `pluxel-plugin-univer-workbooks`
  - service-only：HTTP 数据面（snapshot@rev 强缓存、upload PUT）+ RPC 控制面（open/begin/commit + 文件夹/文件 CRUD）

### 1.2 MVP 保存语义（关键）

- 打开：RPC `openWorkbook(id)` 返回 `latestRev/latestSnapshotUrl/latestEtag/autosavePolicy`
- 保存：前端 `FWorkbook.save()` → `beginSave`（baseRev 乐观锁）→ HTTP PUT upload → `commitSave`
- 冲突：baseRev 不一致返回 `{ conflict: true, currentRev, latestSnapshotUrl }`

这套语义后续会直接复用：AI 应用变更后，仍走同一保存流程。

---

## 2. 新需求拆解：Ax + TOON + ChangeSet

### 2.1 这个过程必然发生在后端吗？

不必然。

- **必然后端**：调用 LLM（Ax）通常需要 Vault 中的 API key、统一的 provider profiles、重试/限流与审计。
- **必然前端**：对 Univer 的“运行时数据与语义写入”必须通过 Facade/Command；并且需要让用户在 UI 中预览/选择是否应用变更。

因此推荐的分工是：**后端生成 ChangeSet，前端预览并应用**。

### 2.2 为什么是 ChangeSet（而不是 AI 直接返回新 snapshot）？

- snapshot 是不透明 blob，直接替换会丢失运行时语义、插件资源、撤销栈等一致性。
- ChangeSet 可逐条预览/勾选，且能在应用前做 **冲突检测（expectedOld）**。
- 未来加入 OT/协作时，ChangeSet 可升级为 ops/transactions，不会推翻现有架构。

---

## 3. 新插件：`pluxel-plugin-univer-ai`（service-only）

### 3.1 插件职责

`pluxel-plugin-univer-ai` 只做三件事：

1) **对接 Ax**：封装 AI 调用（含 streaming）
2) **接收前端上下文**：表格/选区/用户指令（可用 TOON 编码）
3) **产出 ChangeSet**：结构化变更建议 + 解释

约束：

- 不注册 `ext.ui`（继续保持“只有 core 插件碰 UI”边界）
- 不直接读写 Univer 模型
- 不直接改 `pluxel-plugin-univer-workbooks` 的 snapshot 存储（除非未来扩展出“服务器端读取快照片段”的能力）

### 3.2 通信面

- RPC：`UI.rpc.UniverAI`（请求/应答式：适合最小闭环）
- SSE：`univer:ai`（可选：用于 streaming token、进度与最终 ChangeSet）

> 约定建议：UI 的 RPC 入口用 `UniverAI`；推流 namespace 用 `univer:ai`；二者都只由 `pluxel-plugin-univer-ai` 提供。

---

## 4. 数据协议（建议最小但可扩展）

### 4.1 Table Context（前端 → 后端）

前端尽量只发送用户所需的局部上下文（避免把整个 workbook 都塞给 LLM）。

```ts
type TableSlice = {
  workbookId: string
  sheetId?: string
  // A1 / 或者行列区间（更稳）
  range?: { startRow: number; startCol: number; endRow: number; endCol: number }
  // 表格内容（二维数组或行对象数组）
  rows: unknown
  // 可选：列名、格式、当前筛选/排序等
  meta?: Record<string, unknown>
}

type SuggestEditsInput = {
  workbookId: string
  instruction: string
  // promptkit/toon：用于 prompt 内容，而不是必须作为 wire 格式
  context: { format: 'json' | 'toon'; contentType: string; text: string }
  // 产出风格：安全、偏保守/激进
  mode?: 'safe' | 'aggressive'
  // 可选：用于追溯“这一版上下文来自哪里”（便于 UI 上提示与 debug）
  contextHint?: { sheetId?: string; range?: { startRow: number; startCol: number; endRow: number; endCol: number } }
}
```

TOON 的用法可直接复用 `pluxel-plugin-llm-hub` 文档里的推荐方式：

- `formatStructured(value, { format: 'toon' })`（见 `@pluxel/promptkit/toon`）

### 4.2 ChangeSet（后端 → 前端）

ChangeSet 的关键是：**能定位、能预览、能选择性应用、能做冲突检测**。

```ts
type Change = {
  id: string
  sheetId?: string
  range: { startRow: number; startCol: number; endRow: number; endCol: number }
  op: 'setValues' | 'setFormula' | 'clear' | 'setStyle'
  // new value(s)
  value: unknown
  // optional conflict detection
  expectedOld?: unknown
  reason?: string
}

type ChangeSet = {
  id: string
  workbookId: string
  createdAt: number
  model?: string
  summary?: string
  changes: Change[]
}
```

> MVP 先支持 `setValues/clear` 足够；后续逐步扩到 formula/style/row ops。

### 4.3 RPC API（建议形状）

MVP 先走请求/应答式：

```ts
type SuggestEditsResult = { changeSet: ChangeSet }

type UniverAI_Rpc = {
  suggestEdits(input: SuggestEditsInput): Promise<SuggestEditsResult>
}
```

若要 streaming，再加一层 job：

- `startSuggestEdits(input) -> { jobId }`
- SSE `univer:ai` 推送 `{ jobId, kind: 'delta'|'progress'|'final'|'error', ... }`
- `cancel(jobId)`（可选）

---

## 5. 前端 UI/UX（在 core UI 中实现，但逻辑模块化）

### 5.1 UI 形态

在 `UniverEditor` 页面加一个 AI Panel（建议右侧 Drawer / Split Pane）：

- 顶部：指令输入（“做什么”）+ 选区范围/数据量提示
- 中部：AI 输出区（流式 token 或摘要）
- 底部：ChangeSet 列表（可勾选/分组/过滤）

### 5.2 高亮与预览（高效而不污染数据）

MVP 推荐：

- 点击某条 Change：前端仅做两件事
  1) 定位到 sheet + range（设置 selection，滚动到可见）
  2) 在侧边展示 old/new 对比（读取当前格值做预览）
- 勾选后点击“应用所选”：按顺序执行 Univer command/Facade 写入（批量写入尽量走一次 command，或分块 transaction）

#### 5.2.1 Overlay（无数据写入的高亮）

优先使用 Univer 自带的 **range highlight overlay**（不写入单元格样式，不污染 snapshot）：

- `fRange.highlight(style?, primary?) -> IDisposable`
- `fWorksheet.scrollToCell(row, col, duration?)`

实现注意：

- 需要在前端 bundle 中 side-effect 导入 `@univerjs/sheets-ui/facade`，才能拿到 `highlight/scrollToCell` 等 UI mixin 能力。
- 高亮一定要可回收：点击其他 Change 或关闭面板时，调用 `disposable.dispose()` 清理。

后续增强（非 MVP）：

- 预览 Overlay：不写入数据，仅做视觉高亮图层（需要调研 Univer UI/渲染层是否有合适的 overlay/hook）
- “一键撤销”与“分组事务”将依赖 Univer 的 undo 栈与 transaction API（需要进一步调研）

#### 5.2.2 Transaction（把多条写入合成一次 Undo）

Univer 的 Undo/Redo 服务提供了一个临时 batching 能力，可把一段时间内的多个 undo-redo item 合并成单个（更符合“应用所选变更”的用户预期）：

- `IUndoRedoService.__tempBatchingUndoRedo(unitId) -> IDisposable`

使用方式（前端）：

1) `const batching = undoRedo.__tempBatchingUndoRedo(workbookId)`
2) 在 batching 期间执行多次 `fRange.setValues(...)` / `fRange.clearContent(...)` 等写入
3) `batching.dispose()` 结束 batching（生成单条 undo 记录）

> 该 API 标注为 `@deprecated`（临时方案），但对 MVP 足够；后续可替换为官方稳定的 transaction API 或自定义 command（一次性生成 undo/redo mutations）。

### 5.3 冲突检测

应用前对每条 Change：

- 若存在 `expectedOld`，比较当前单元格值
  - 一致：允许应用
  - 不一致：标红并要求用户手动选择（跳过/仍应用/先刷新）

### 5.4 与保存工作流衔接

应用成功后：

- 触发 dirty（命令监听本身就会置 dirty）
- 走现有 autosave / 手动保存即可（无需新协议）

---

## 6. Durable Streams 是否适合用来做 LLM 对话？

结论（建议）：**适合“长耗时、需要断线续传/多端追 tail”的 streaming 对话/agent 场景，但 MVP 不必引入**。

Durable Streams（GitHub: https://github.com/durable-streams/durable-streams ）看起来是一个“可恢复流”的基础设施抽象：用 **offset-based 的 append-only stream** 组织输出，客户端可从上次 offset 继续读（类似“断线续传的 tail -f”）。

在 Pluxel 当前体系下：

- MVP：用 `ext.sse` 推流 + 前端本地状态即可（实现成本最低）
- 若未来要：
  - “刷新页面后继续看到正在生成的 LLM 响应”
  - “同一会话多 tab 同时观看”
  - “后台 job 推送到前端（无长连接保持）”
  
  那么 Durable Streams 是一个很合适的抽象层候选（把“可恢复流”做成基础设施能力，UI/服务只管 append + read/tail）。

评估点（落地前需要确认）：

- 本项目运行环境是否适配 durable-streams 的服务端实现（存储、认证、权限）
- 是否要把它做成“通用的 pluxel stream service”，而不只服务 Univer AI
- 与现有 runtime logs / SSE 的职责边界

---

## 7. 实现计划（下一步讨论用）

### Phase 1（MVP：可用的 AI 变更建议）

1) `pluxel-plugin-univer-ai`：
   - 依赖 `pluxel-plugin-llm-hub`（LLM 调用）+ `@pluxel/promptkit/toon`（TOON 编码）
   - 提供 `suggestEdits(input) -> ChangeSet`（先非流式）
2) core 编辑页：
   - AI Panel UI（输入指令、显示 ChangeSet、勾选应用）
   - 应用 `setValues/clear` 到当前 workbook

### Phase 2（Streaming + 可恢复）

- `startSuggestEdits()` → `jobId`，SSE `univer:ai` 推送 token/进度/ChangeSet
- 可选：把 job 的输出落到可恢复流（Durable Streams 或自研轻量 offset log）

### Phase 3（更强的上下文与安全）

- 前端“上下文采样策略”：只取可见区域/选区 + 限制行列数
- 服务器端可选读取 last-saved snapshot（只作为补充上下文）
- 变更集类型扩展（formula/style/insertRows 等）与更强冲突检测

---

## 8. 参考链接（link-first）

- LLM Hub 插件：`plugins/ai/llm-hub/README.md`
- TOON：`packages/promptkit/src/toon.ts`
- Univer `IWorkbookData`（snapshot 结构）：https://docs.univer.ai/guides/sheets/model/workbook-data
- Univer Facade `FWorkbook.save()`：https://docs.univer.ai/en-US/reference/facade/f-workbook
- Univer Facade `FRange.highlight()`（overlay 高亮）：https://docs.univer.ai/en-US/reference/facade/f-range
- Univer Playground（Sheets via plugin）：https://docs.univer.ai/en-US/playground/sheets/basic-via-plugin
- Undo/Redo batching（临时 API）：`@univerjs/core` types `services/undoredo/undoredo.service.d.ts`
