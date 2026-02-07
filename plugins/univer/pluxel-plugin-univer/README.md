# pluxel-plugin-univer

Univer 的核心前端插件（唯一触达 `ext.ui`）。

## Responsibilities

- 注册 `ext.ui`：
  - 文档管理（文件夹/工作簿浏览）
  - Univer 编辑页（standalone route）
- 在浏览器侧创建/销毁 Univer 实例，并加载 `IWorkbookData` snapshot
- 监听命令执行，做 dirty 标记与 autosave（通过 `pluxel-plugin-univer-workbooks` 的两段式保存）
- 统一承载“前端已打包的 Univer 能力开关”（例如 watermark），其它 service 插件不直接注册 UI

## Structure

- 文档管理页：`plugins/univer/pluxel-plugin-univer/src/ui/pages/docs-tab.tsx`
- 编辑页（Univer mount + 保存 + AI Drawer）：`plugins/univer/pluxel-plugin-univer/src/ui/pages/editor-page.tsx`
- Univer runtime（create/highlight/undo-batch）：`plugins/univer/pluxel-plugin-univer/src/ui/univer/runtime.ts`
- AI Debug（TOON 预览）：`plugins/univer/pluxel-plugin-univer/src/ui/ai/ai-panel.tsx`

## Overlay + Transaction (MVP)

为后续 “变更集预览/勾选应用” 的 UX，核心前端提供两类基础能力：

1) **Overlay 高亮（不写入数据）**
   - `@univerjs/sheets-ui/facade` 提供 `fRange.highlight(...)` 与 `fWorksheet.scrollToCell(...)`
   - 用于点击变更时定位 + 视觉高亮（不污染 snapshot）
   - 参考：`https://docs.univer.ai/en-US/reference/facade/f-range`
   - 本仓库实现：`plugins/univer/pluxel-plugin-univer/src/ui/univer/runtime.ts`（`createUniverRuntime().highlightRange()`）

2) **Transaction（把多条写入合成一次 Undo）**
   - 通过 `IUndoRedoService.__tempBatchingUndoRedo(unitId)` 把多个写入的 undo-redo item 合并为单条
   - 用于 “应用所选变更” 时给用户一个自然的撤销体验
   - 参考：`@univerjs/core` types `services/undoredo/undoredo.service.d.ts`
   - 本仓库实现：`plugins/univer/pluxel-plugin-univer/src/ui/univer/runtime.ts`（`createUniverRuntime().withUndoBatch()`）

## AI Panel (debug)

AI Drawer 里包含一个轻量的 Debug 区域：
- 读取当前选区并用 `@pluxel/promptkit/toon` 生成 TOON 文本预览（便于确认上下文裁剪是否合理）
- 默认：生成建议时直接用 TOON 作为请求上下文（所见即所得、payload 更小）；也可切回 JSON wire（便于外部调用/调试）
- 展示后端使用的 LLM profile（来自 `pluxel-plugin-llm-hub` 的选路结果）
