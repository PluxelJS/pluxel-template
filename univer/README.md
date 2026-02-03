# Univer（表格）集成

此目录下的包用于把 Univer Sheets 集成到 Pluxel 插件系统里，同时让 Univer 自己的插件/预设体系与 Pluxel 的插件体系“并存但不互相污染”：

- `pluxel-plugin-univer-sheets`：**Hub 插件**（提供 `/sheets` UI + 统一配置 + RPC + 贡献点）
- `pluxel-plugin-univer-watermark-demo`：**外部扩展示例**（通过 Pluxel configs 驱动 Univer Watermark）
- `pluxel-plugin-univer-sheets-studio`：**编辑工作台**（提供 `/sheets-studio`，用于“程序化编辑表格数据”的最小 UI；未来可在此基础上接入 ax）

## 设计原则（从简）

- Univer 的能力尽量以 **Univer 原生 API** 的方式使用（UI 侧直接拿 `univerAPI` 调用）。
- 只有“有明确配置空间、且适合作为扩展点”的能力，才拆成 Pluxel 插件（例如 watermark）。
- 其它常见能力（filter/sort/find-replace…）默认作为 Hub 的 **可开关 preset/plugin**，用一份 settings 控制。

## 免费优先（高级能力仅作参考）

我默认把“可选但不影响核心表格体验”的能力都做成 **默认关闭** 的开关（例如脚本、绘图、表格样式、讨论串等），避免免费版/轻量场景一上来就背负额外复杂度。

如果你之后要参考 Univer 的 Pro/Server 能力（协作、导入导出、打印、透视表、图表、Live-share…），建议只把它们当成“文档参考”，不要在模板里默认依赖（避免后续迁移/授权成本）。

## 路由

- `pluxel-plugin-univer-sheets` 提供路由：`/sheets`（导航标题：`Univer 表格`）
- `pluxel-plugin-univer-sheets-studio` 提供路由：`/sheets-studio`（导航标题：`Sheets Studio`）

## 配置（示例）

该仓库的运行时配置会从 `default.json` seed 到本地 store（通常写入 `.pluxel/` 下）。你可以把 Univer 相关配置写到对应插件名下：

```jsonc
{
  "json": {
    "enabled": ["UniverSheetsHub", "UniverWatermarkDemo"],
    "plugins": {
      "UniverSheetsHub": {
        "settings": {
          "locale": "zh-CN",
          "enableFilter": true,
          "enableSort": true,
          "enableFindReplace": true,
          "enableNote": true,
          "enableHyperLink": true,
          "enableDataValidation": true,
          "enableConditionalFormatting": false,
          "enableCrosshairHighlight": true,
          "enableZenEditor": false,
          "enableUniscript": false,
          "enableTable": false,
          "enableDrawing": false,
          "enableThreadComment": false,
          "persistence": {
            "enabled": true,
            "storeId": "pluxel",
            "docId": "default",
            "autoLoadOnStart": true,
            "autoSave": false,
            "autoSaveDebounceMs": 800,
            "//": "存储位置由 Pluxel 内核管理（插件数据目录），无需配置路径"
          }
        }
      },
      "UniverWatermarkDemo": {
        "watermark": {
          "enabled": true,
          "content": "Pluxel × Univer（水印来自配置）",
          "fontSize": 28,
          "rotate": -15,
          "opacity": 0.2,
          "repeat": true,
          "color": "rgba(120, 120, 120, 0.28)"
        }
      }
    }
  }
}
```

## 业务侧“持久化存储表”的最小用法

UI 侧直接用 Univer facade：

- 保存：`univerAPI.getActiveWorkbook()?.save()`
- 恢复：`univerAPI.createWorkbook(snapshot)`

而存取落盘通过 Hub RPC（`ctx.services.hmr.ui.UniverSheetsHub`）：

```ts
const api = ctx.services.hmr.ui.UniverSheetsHub
const workbook = univerAPI.getActiveWorkbook()
if (!workbook) return

const snapshot = workbook.save()
await api.saveSnapshot('default', snapshot)

const file = await api.loadSnapshot('default')
if (file?.snapshot) {
  univerAPI.createWorkbook(file.snapshot)
}
```

## 增量同步（patch log + SSE，durable-streams 风格）

`pluginData`（SignalDB）本质上是**服务端持久化**，不会“自动把数据同步到浏览器”。要做多端/多标签页的增量同步，需要显式的传输层（SSE/WS）+ 可恢复的偏移量（seq）。

本模板里 `UniverSheetsHub` 提供了一套最小、可扩展的增量链路：

- RPC `docBootstrap(docId, afterSeq)`：返回 `{ snapshot, baseSeq, lastSeq, patches }`
- RPC `appendPatch(docId, patch, { sourceId })`：追加 patch 并返回 `{ seq, ... }`
- SSE `UniverSheetsHub`：推送 `{ type:'ready' | 'patch', seq, ... }`，客户端以 `seq` 作为 offset 断点续传

这套语义与 durable-streams 的“offset + 增量重放”非常接近；后续如果你真的想引入 `durable-streams/durable-streams`，更建议把它当成 **patch log 的替代/增强实现**（或跨进程复制层），而不是把它和 Univer API 绑定在一起。

## “文件/文件夹”管理（虚拟工作区）

为了支持未来很多表格文件（以及按路径分组），`UniverSheetsHub` 把 `docId` 视为**路径**（例如 `demo/2026/q1`），并提供了一套最小但完整的管理 API（都走 RPC）：

- `docs()`：列出全部文档（包含 `createdAt/updatedAt`、`hasSnapshot`、`lastSeq` 等）
- `folders()`：列出显式创建过的文件夹
- `tree(prefix)`：列出某个路径下的**直接子文件夹 + 直接子文档**
- `createDoc(docId, { title? })` / `deleteDoc(docId)` / `renameDoc(from, to)`
- `createFolder(folderId, { title? })` / `deleteFolder(folderId, { recursive? })` / `renameFolder(from, to)`

示例（UI 插件里）：

```ts
const hub = ctx.services.hmr.ui.UniverSheetsHub

await hub.createFolder('demo/2026')
await hub.createDoc('demo/2026/q1', { title: 'Q1 报表' })

const tree = await hub.tree('demo/2026')
// tree.folders / tree.docs

await hub.renameDoc('demo/2026/q1', 'demo/2026/q1-v2')
await hub.deleteFolder('demo/2026', { recursive: true })
```

## 给未来 ax 插件的建议（先把核心打磨好）

如果你要做 “ax × Univer（AI 编辑表格）”，我更推荐 **另写一个独立插件**：

- 依赖：`pluxel-plugin-ax` + `pluxel-plugin-univer-sheets`
- 自己提供 UI route（例如 `/sheets-ai`），把 Univer 画布与 ax 对话/工具面板并排呈现
- 通过 `pluxel-plugin-univer-sheets/ui-kit` 复用 Univer 的 bootstrap（locale/presets/plugins/CSS 组合），避免复制粘贴
- AI 编辑时尽量走 “命令/patch” 的思路，不要每次都全量 snapshot 往返（除非你要做“保存/版本”）
