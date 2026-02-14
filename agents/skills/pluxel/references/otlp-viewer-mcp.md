# OTLP Viewer MCP（给 LLM/agent 用的“记录查询面板”）

目标：让模型在“修 bug / 调试 loopback / 看 span+error”时，不用盲猜状态，直接从 OTLP viewer 的本地 DuckDB 里查到**最近错误 + 对应 trace**。

## 前置：启用 OTLP + Viewer

1) 启用 `pluxel-plugin-otlp` 与 `pluxel-plugin-otlp-viewer`
2) 确保 `OtlpHub` signals 打开（否则 spans/logs 捕获不到）

推荐（仅 tap，不 push 到外部 collector）：

```ts
host.cfg('OtlpHub').set({
  exporting: { mode: 'tap' },
  signals: { logs: true, traces: true, metrics: true },
})
```

## MCP endpoint（HTTP）

OTLP Viewer 插件会在 host 内挂一个 MCP server（Streamable HTTP transport）：

- Endpoint: `/api/otlp-viewer/mcp`

说明：
- 这是“插件自己的 MCP server”，不是 host 的 `/api/mcp`（后者主要管 HMR/logs/plugin lifecycle）。
- 若 host 开启了 AuthGuard，`/api/*` 可能需要先登录。

## 推荐工具集（按调试顺序）

1) 先看最近错误（最省 token）
- `otlpViewer.errorsText` `{ sinceTsMs?, limit?, q?, filters? }`

2) 拿到 `trace_id` 后看 trace 详情
- `otlpViewer.getTrace` `{ traceId }`

3) 需要扫最近的 logs/spans/metrics（带结构化过滤）
- `otlpViewer.listText` `{ signal, opts, format? }`

4) 做 attribute facet（找 key/value 分布，适合定位 runId/provider/model）
- `otlpViewer.facetKeys` / `otlpViewer.facetValues`

5) 最后手段：直接 SQL（dev-only）
- `otlpViewer.query` `{ sql, params? }`
  - 表：`otlp_logs` / `otlp_spans` / `otlp_metrics`

## 常用过滤（结构化 filters）

`filters` 里支持两类字段：
- 列字段（会被白名单限制）：`callerId` / `traceId` / `spanId` / `status` / `name` / `level` / `type` / `startTsMs` / `durationMs` / `tsMs` / `value`
- attributes：`attr.<key>`（例如 `attr.llm.provider` / `attr.univer.run_id`）

示例（只看 Univer loopback + 指定 runId）：

```json
{
  "filters": [
    { "field": "attr.otel.tracer.name", "op": "eq", "value": "univer.loopback" },
    { "field": "attr.univer.run_id", "op": "eq", "value": "<runId>" }
  ]
}
```

