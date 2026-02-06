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

- 文档管理页：`univer/pluxel-plugin-univer/src/ui/pages/docs-tab.tsx`
- 编辑页（Univer mount + 保存 + AI Drawer）：`univer/pluxel-plugin-univer/src/ui/pages/editor-page.tsx`
- Univer runtime（create/highlight/undo-batch）：`univer/pluxel-plugin-univer/src/ui/univer/runtime.ts`

## Overlay + Transaction (MVP)

为后续 “变更集预览/勾选应用” 的 UX，核心前端提供两类基础能力：

1) **Overlay 高亮（不写入数据）**
   - `@univerjs/sheets-ui/facade` 提供 `fRange.highlight(...)` 与 `fWorksheet.scrollToCell(...)`
   - 用于点击变更时定位 + 视觉高亮（不污染 snapshot）
   - 参考：`https://docs.univer.ai/en-US/reference/facade/f-range`
   - 本仓库实现：`univer/pluxel-plugin-univer/src/ui/univer/runtime.ts`（`createUniverRuntime().highlightRange()`）

2) **Transaction（把多条写入合成一次 Undo）**
   - 通过 `IUndoRedoService.__tempBatchingUndoRedo(unitId)` 把多个写入的 undo-redo item 合并为单条
   - 用于 “应用所选变更” 时给用户一个自然的撤销体验
   - 参考：`@univerjs/core` types `services/undoredo/undoredo.service.d.ts`
   - 本仓库实现：`univer/pluxel-plugin-univer/src/ui/univer/runtime.ts`（`createUniverRuntime().withUndoBatch()`）
