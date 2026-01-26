# pluxel-plugin-napi-rs

tsdown 构建的通用 napi-rs vendor 工具，配套 `vendor.manifest.json` 追踪包列表与版本（不再在代码里写死默认包）。

## 常用命令
- 构建产物（dist 自动写入）：`pnpm --filter pluxel-plugin-napi-rs build`
- 从 manifest 同步全部包：`pnpm --filter pluxel-plugin-napi-rs vendor`（manifest 为空时会报错并提示补充）。
- 临时指定包列表（不改 manifest 也行）：`pnpm --filter pluxel-plugin-napi-rs vendor -- --packages "@napi-rs/pinyin@latest @node-rs/jieba@2.0.1"`
- 单独 vendor 一个包：`pnpm --filter pluxel-plugin-napi-rs vendor -- @napi-rs/<pkg> [version] [outDir]`
  - 省略 `version` 或填 `latest` 会自动解析最新版本并写回 manifest。
- 每次 vendor 会自动把 `package.json` 的 `exports` 补齐（按包名末段，例如 `@napi-rs/pinyin` -> `./pinyin` 指向对应 outDir 的 `index.js`）。

## 运行时下载位置
- `.node` 二进制按需下载到 `<cwd>/napi-rs/<binaryName>/` 下，设置 `NAPI_RS_DISABLE_RUNTIME_DOWNLOAD=1` 可禁止自动下载。
