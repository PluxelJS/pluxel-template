# Render plugins

目标：提供渲染/图形相关能力（通常涉及 native 依赖或 worker 池）。

包清单：
- Canvas worker：`pluxel-plugin-canvas-worker`
- ECharts：`pluxel-plugin-echarts`
- Font manager：`pluxel-plugin-font-manager`
- Meme worker：`pluxel-plugin-meme-worker`

常见注意：
- 这类插件往往需要 `pluxel-plugin-napi-rs`（native 下载/绑定层）。在产品仓库里安装依赖后，如果看到 `pluxel-napi-rs` bin 缺失，多半是没先 build 该包的 dist。

