# 写插件（从 demo 复制最小片段）

## 从哪里抄（找到 demo 目录 + 索引）

常见位置（择一存在即可）：
- `docs/pluxel-demos/`
- `packages/plugins/host/src/demo/`

索引文件（先读这个；找不到就用 `rg` 搜）：
- `docs/pluxel-demos/README.md`
- `packages/plugins/host/src/demo/README.md`

常用 demo 文件名（在上述目录里找同名文件即可）：
- `PluginEventsDemo.ts`
- `PluginHonoGraphQLDemo.ts`
- `PluginVaultDemo.ts`
- `PluginWithUI.ts`
- `PluginStandaloneFrameDemo.ts`

## 规则（最重要的几条）
1) 所有副作用都绑到 `ctx.effects`（定时器/订阅/路由必须可清理）
2) 能用 `configs.use(...)` / `features.use(...)` 就别手写“隐式注册”
3) 可测试的优先写测试；只有 UI/HMR/log streams 才跑真实宿主

## 运行
```bash
# 先看看 repo 里有哪些可用脚本（避免猜不存在的命令）
pnpm -s run | rg -n "^(dev|hmr)|plugins-host|test"

pnpm exec tsc -p docs/pluxel-demos/tsconfig.json
# 或：pnpm exec tsc -p packages/plugins/host/src/demo/tsconfig.json
pnpm dev
pnpm dev:demos
# 或：pnpm --filter @pluxel/plugins-host hmr
```

## UI 路由（记住这两个）
- Shell：`/ext/<pluginName><path>`
- Standalone：`/ext-standalone/<pluginName><path>`
