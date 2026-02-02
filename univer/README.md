# Univer（表格）集成

此目录下的包用于把 Univer Sheets 集成到 Pluxel 插件系统里，同时让 Univer 自己的插件/预设体系与 Pluxel 的插件体系“并存但不互相污染”：

- `pluxel-plugin-univer-sheets`：**Hub 插件**（提供 `/sheets` UI + 统一配置 + RPC + 贡献点）
- `pluxel-plugin-univer-watermark-demo`：**外部扩展示例**（通过 Pluxel configs 驱动 Univer Watermark）

## 设计原则（从简）

- Univer 的能力尽量以 **Univer 原生 API** 的方式使用（UI 侧直接拿 `univerAPI` 调用）。
- 只有“有明确配置空间、且适合作为扩展点”的能力，才拆成 Pluxel 插件（例如 watermark）。
- 其它常见能力（filter/sort/find-replace…）默认作为 Hub 的 **可开关 preset/plugin**，用一份 settings 控制。

## 路由

- `pluxel-plugin-univer-sheets` 提供路由：`/sheets`（导航标题：`Univer 表格`）

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
            "docId": "default",
            "autoLoadOnStart": true,
            "autoSave": false,
            "autoSaveDebounceMs": 800,
            "storageDir": ".pluxel/univer-sheets"
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

