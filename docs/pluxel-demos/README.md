# Demo plugins（复制改写用）

`docs/pluxel-demos/` 是“演示/参考实现”插件集合：目标是让你（或 LLM）直接复制最小片段改成自己的插件。

## 运行（可选）
```bash
pnpm dev:demos
```
说明：
- demo 默认不参与 HMR 扫描；`dev:demos` 才会加载它们（使用 `pluxel.hmr.demos.jsonc`）
- Host 默认在 `http://localhost:3000`
- UI 路由速记：
  - Shell：`/ext/<pluginName><path>`
  - Standalone：`/ext-standalone/<pluginName><path>`

## 清单（建议阅读顺序）

- `PluginEventsDemo.ts`：两种事件通信方式（EvtChannel + declare module 全局事件合同）。
- `PluginHonoGraphQLDemo.ts`：插件里使用 `ctx.honoService.modifyApp()` + `features.dep(GraphQLPlugin).useModule()`。
- `PluginBuiltinShowcase.ts`：尽量只用 builtin UI/config 的“大而全”样例（表单 meta、SSE state、内置文档块等）。
- `PluginFeatureConfigDemo.ts`：Feature 配置归因到父插件配置页（schema key 形如 `cache.config` / `cache.rules`，UI 会按 group 自动分组）。
- `PluginFeatureDepsDemo.ts`：FeatureHost 的“唯一推荐 API”（`use()` / `dep()` / BridgePlugin）。
- `PluginVaultDemo.ts`：插件里使用 `ctx.vault.open()` 做加密持久化（token/secret/batch/lock）。
- `PluginWithUI.ts` + `PluginWithUI/ui/*`：完整链路（UI + RPC + SSE + 持久化 state）。
- `PluginStandaloneFrameDemo.ts` + `PluginStandaloneFrameDemo/ui/*`：演示插件 routes 的 `frame: 'standalone'`（无 navbar/sidebar，但仍在同一 App/鉴权策略下运行）。
- `advanced/DemoBaseProviders.ts`：抽象基类 Token + 多实现（Provider 选择）。
- `advanced/DemoForks.ts`：ForkablePlugin（同插件多实例 / fork）。

## Demo 仅做类型检查

```bash
pnpm exec tsc -p docs/pluxel-demos/tsconfig.json
```

## 非 demo（功能性示例）

- 本模板的功能性示例主要在 `plugins/**` 下；按需启用请看 `pluxel.hmr.jsonc` 与各 plugin 的 README。
