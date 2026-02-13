# pluxel-plugin-otlp-viewer

开发时 OTLP viewer 插件：通过 `OtlpHub.registerTap()` 截获 `pluxel-plugin-otlp` 收到的 logs/traces/metrics，落到本地 DuckDB（默认 `:memory:`），并注册一个独立页面用于高效浏览/筛选/SQL 查询。

## Enable

1) 确保启用 `pluxel-plugin-otlp` 与本插件（`pluxel-plugin-otlp-viewer`）。
2) 配置 `OtlpHub` 负责 OTLP push（生产建议发到专门的后端/DB）。
3) `pluxel-plugin-otlp-viewer` 会通过 `OtlpHub.registerTap()` 截获 `otlp.log/trace/metric` 的输入并落到本地 DuckDB（默认 `:memory:`），用于开发/测试快速浏览。

如果你本地没有 collector/远端服务，推荐直接关闭 `OtlpHub` exporting，仅让 viewer 截获：

```ts
host.cfg('OtlpHub').set({
  exporting: { mode: 'tap' }, // 不 push
  signals: { logs: true, traces: true, metrics: true }, // viewer 才能捕获（尤其是 spans）
})
```

```ts
host.cfg('OtlpHub').set({
  exporting: { mode: 'push', push: { endpoint: 'http://localhost:4318' } },
  signals: { logs: true, traces: true, metrics: true },
})
```

## UI

启动带 UI 扩展的 HMR host 后打开页面：

- Route：`/otlp`（standalone frame）
- Traces：trace summary → 点击进入 trace 详情（span tree + timeline）
- Logs/Metrics：列表 + 行详情抽屉（Error/Attributes/Events/Raw）
- Filters：在左侧 Drawer 里做结构化过滤 + Attribute Explorer（keys/values facet）
- SQL：直接对 `otlp_logs` / `otlp_spans` / `otlp_metrics` 执行 DuckDB SQL

## 观测 Univer AxFlow（过滤建议）

Univer loopback（AxFlow）会写入 OTLP traces，并把 LLM 请求 fetch span 命名为 `univer.ax.fetch`。

常用过滤（在 OTLP Viewer 的 `Filters` Drawer 里添加）：
- 只看 Univer loopback：`attr.otel.tracer.name = univer.loopback`
- 只看 AxFlow：`attr.ax.flow = univer.loopback`
- 只看 Ax LLM 请求：`name contains univer.ax.fetch`
- 只看某个 provider/model：`attr.llm.provider = <provider>` / `attr.llm.model = <model>`
- 只看某次 run：从 Univer UI 里复制 `runId`，然后 `attr.univer.run_id = <runId>`
- 限定 workbook：`attr.univer.workbook_id = <workbookId>`
