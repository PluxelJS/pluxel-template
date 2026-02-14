# 测试（默认：`@pluxel/test`）

能测就测：行为/生命周期/配置/依赖注入都优先用测试覆盖。只有必须真实 runtime（UI/HMR/log streams）才跑宿主或 MCP。

## Non-negotiables (do not break)

1) Import from `@pluxel/test` only (Host + base classes + decorators).
2) Classes using `this.configs.use(...)` / `this.features.use(...)` as fields must be module top-level (not inside `it()`).
3) Do not read config values in constructors/field initializers; read in `init()`/methods.
4) Configure via Host API (`host.cfg(...).set(...)`, `host.commit(...)`).
5) Do not import `reflect-metadata`.

## Minimal pattern (Host API)

```ts
import { Plugin, BasePlugin, withHost } from '@pluxel/test'

@Plugin({ name: 'P' })
class P extends BasePlugin {}

await withHost(async (host) => {
  host.add(P)
  host.cfg(P).set({ answer: 42 })
  await host.commit()
  host.require(P)
})
```

## Debug start failures (no log guessing)

```ts
host.ctx.on('startError', (pluginCtx, err) => {
  console.error('[startError]', pluginCtx.pluginInfo.id, err)
})
host.ctx.on('resolveError', (id, err) => {
  console.error('[resolveError]', String(id), err)
})
```

## Commands

- 跑测试：`pnpm test:vitest`（若存在）
- 跑单包：`pnpm --filter <pkg> test`（若存在）

## 定位文档（可移植）

如果仓库里有上游测试指南，用搜索定位（不要写死路径）：
```bash
rg -n "LLM_TESTING_GUIDE|withHost\\(|host\\.cfg\\(|startError|resolveError" -S .
```
