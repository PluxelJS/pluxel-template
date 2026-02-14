# MCP/HMR loopback（最后手段）

只有当测试无法表达场景（必须真实 host UI/HMR/log streams/集成）时才用。

## Endpoint

- 内部 MCP endpoint：`/api/mcp`
- 鉴权：`/api/*` 可能受 AuthGuard 保护；用 `/api/auth/meta` 判断是否需要登录

## 定位实现（可移植）

不要写死仓库路径；需要找实现时按 route/tool 名搜索：

```bash
rg -n "\"/mcp\"|/api/mcp|plugin\\.start|plugin\\.stop|plugin\\.restart|hmr\\.waitForStable|logs\\.latestText|logs\\.waitForText" -S .
```

## 最小工具集

- `plugin.start` `{ name }` → starts plugin and commits.
- `plugin.stop` `{ name }` → stops plugin and commits.
- `plugin.restart` `{ name }` → restarts plugin and commits.
- `hmr.waitForBatch` `{ afterEpoch?, timeoutMs? }` → waits for the next completed HMR batch and returns a summary.
- `hmr.waitForStable` `{ afterEpoch?, timeoutMs?, quietMs? }` → waits until HMR becomes quiet/stable, then returns the most recent batch summary (recommended for agents).
- `logs.latest` `{ filter?, afterId?, limit? }` → returns an in-memory log snapshot.
- `logs.waitFor` `{ filter?, afterId?, limit?, timeoutMs? }` → waits until at least one matching log arrives (or timeout) and returns a snapshot.
- `logs.latestText` `{ filter?, afterId?, limit?, format? }` → returns an LLM-friendly compact text snapshot (recommended for agents).
- `logs.waitForText` `{ filter?, afterId?, limit?, timeoutMs?, format? }` → wait + return LLM-friendly compact text (recommended for agents).

## 推荐执行环

1) 改代码
2) 调 `hmr.waitForStable`，失败就先停（不要继续猜）
3) 读日志：`logs.latestText`（或用 `logs.waitForText` + `afterId` 追增量）
4) 不要“靠日志猜状态”；优先找/补一个明确的 status API
