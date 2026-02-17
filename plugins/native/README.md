# Native plugins

目标：放置与 native runtime/绑定相关的插件包或 shim。

包清单：
- `pluxel-plugin-napi-rs`：napi-rs runtime downloader + bindings shim

提示：native 包通常需要先 build 出 `dist/`，并可能依赖本机平台与缓存目录；请优先复用现有脚本与 README 指引。

