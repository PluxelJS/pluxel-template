# Builtin plugins

`plugins/builtin/*` 放的是“基础设施型”的插件包，常见做法是：

- 在 `pluxel.hmr.jsonc` 的 `profiles[*].builtin` 里把它们作为 baseline 预加载（从 dist `.mjs` 加载）
- 业务插件在运行时依赖它们提供的 token/服务

当前内置包：
- `@pluxel/graphql`
- `@pluxel/websocket`
- `@pluxel/wretch`

相关语义请读 `HMR_WORKSPACE_PROFILES.md` 的 Builtins 一节（避免同时作为 builtin + entry 双加载导致冲突）。

