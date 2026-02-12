# pluxel-plugin-otlp

Pluxel/HMR runtime 的 OTLP exporter 插件（当前实现：OTLP/HTTP JSON Traces/Metrics/Logs）。

设计目标：
- **小表面积**：`Otlp.log/logger`（logs）+ `Otlp.trace/span`（traces）+ `Otlp.metric/counter/gauge/histogram`（metrics）+ `flush/stats`。
- **Push-based**：按 batch/interval 自动 flush（也可手动 `flush()`）。
- **有界内存**：队列上限 + 明确溢出策略（dropNewest / dropOldest / block）。
- **Config-first**：默认禁用；启用与细节全部来自 `configs.use(schema)` 注册的配置 schema。

现状：
- ✅ Logs：`core.endpoint + "/v1/logs"`
- ✅ Traces：`core.endpoint + "/v1/traces"`（`otlp.trace(...)` / `otlp.span(...)`）
- ✅ Metrics：`core.endpoint + "/v1/metrics"`（`otlp.metric(...)` + `otlp.counter/gauge/histogram`）

默认启用策略（保守默认值）：
- `core.enabled=false`（默认禁用）
- `signals.logs=false`、`signals.traces=true`、`signals.metrics=true`（默认用 traces+metrics；logs 可选）

## Register

```ts
import { plugins as otlpPlugins } from 'pluxel-plugin-otlp'
```

通常在宿主把插件集注册进 runtime（示例以 `@pluxel/test` 的 Host API 表达思路；具体以你的 host 实现为准）：

```ts
import { withHost } from '@pluxel/test'
import { plugins as otlpPlugins } from 'pluxel-plugin-otlp'

await withHost(async (host) => {
  host.add(otlpPlugins)
  await host.commit()
})
```

## Use as a service

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { Otlp } from 'pluxel-plugin-otlp'
import { createOtlpOtelTracer } from 'pluxel-plugin-otlp/otel'

@Plugin({ name: 'MyPlugin' })
export class MyPlugin extends BasePlugin {
	constructor(private readonly otlp: Otlp) {
		super()
	}

	override async init() {
		const tracer = createOtlpOtelTracer(this.otlp, { tracerName: 'my-plugin' })
		tracer.startActiveSpan('MyPlugin.init', { attributes: { feature: 'demo' } }, (span) => span.end())
	}
}
```

### Logs：推荐用法合集

#### 1) 单条 / 批量写入

```ts
await otlp.log({ level: 'info', body: 'hello', attributes: { userId: 'u_123' } })

await otlp.log([
  { level: 'debug', body: 'step1' },
  { level: 'debug', body: 'step2', attributes: { ok: true } },
])
```

字段说明（`OtlpLogRecordInput`）：
- `level`：`trace|debug|info|warn|error|fatal`，默认 `info`
- `body`：任意值（会被转成 OTLP AnyValue；对象/数组会递归）
- `attributes`：额外 attributes（会与插件内置 attributes 合并）
- `tsMs`：可选自定义时间戳（毫秒）

插件会自动补充 attributes：
- `pluxel.provider.*`：服务提供方（OtlpHub 自身）
- `pluxel.caller.*`：调用方插件（从 `ctx.caller` 推断）

#### 2) `logger()`：结构化 + 复用 attributes

```ts
const log = otlp.logger({ attributes: { feature: 'payments' } })
await log.info('ready')

const reqLog = log.child({ requestId: 'r_001' })
await reqLog.warn('slow', { durationMs: 1200 })
```

#### 3) `flush()`：手动推进（适合退出/测试）

```ts
await otlp.flush() // best-effort：把队列尽量 drain 完
```

#### 4) `stats()`：观测队列/丢弃/错误

```ts
const s = otlp.stats()
// { enabled, queued, inflight, sent, dropped, lastError?, signals: { logs, traces, metrics } }
```

## Config

默认禁用；启用后通过 OTLP/HTTP 上报到 `core.endpoint + "/v1/traces"`、`"/v1/metrics"`（logs 可选）。

```ts
// tests / host bootstrap
host.cfg('OtlpHub').set({
  core: { enabled: true, endpoint: 'http://localhost:4318' },
  signals: { traces: true, metrics: true, logs: false },
  // 可选：headers (例如鉴权 / 多租户)
  // core: { enabled: true, endpoint: 'http://localhost:4318', headers: { Authorization: 'Bearer ...' } },
  // 可选：resource/scope (用于 resourceLogs / scopeLogs)
  // resourceCfg: { serviceName: 'pluxel', serviceVersion: '0.1.0', resourceAttributes: { env: 'dev' } },
  // scopeCfg: { name: 'my-app', version: '2026.01.23' },
  batch: { flushIntervalMs: 250, maxBatchRecords: 512, maxInflight: 2 },
  queueCfg: { overflow: 'block', maxQueuedRecords: 10_000 },
})
```

Push/backpressure 语义速记：
- `flushIntervalMs`：达到间隔就 flush（即使 batch 未满）。
- `maxBatchRecords` / `maxBatchBytes`：达到阈值立即 flush。
- `maxInflight`：并行 in-flight 请求上限。
- `queueCfg.overflow`：
  - `dropNewest`：队列满就丢新（默认，避免拖慢业务）
  - `dropOldest`：队列满就丢旧（尽量保留“新鲜”数据）
  - `block`：写入会等待队列腾挪（最强背压，可能影响业务延迟）

## Decorators

```ts
import type { OtlpLogger } from 'pluxel-plugin-otlp'
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { Otlp } from 'pluxel-plugin-otlp'
import { OtlpSpan, WithOtlpLogger } from 'pluxel-plugin-otlp/decorators'

@Plugin({ name: 'MyPlugin' })
export class MyPlugin extends BasePlugin {
	constructor(_otlp: Otlp) {
		super()
	}

	@OtlpSpan({ name: 'MyPlugin.run' })
	@WithOtlpLogger()
	async run(log: OtlpLogger) {
		await log.info('hello')
	}
}
```

补充：
- `@WithOtlp()`：把 `otlp: Otlp` 注入到被装饰方法的第一个参数。
- `@WithOtlpLogger({ attributes })`：把 `log: OtlpLogger` 注入到被装饰方法的第一个参数。
- `@OtlpSpan()`：在方法成功/失败时发出一个 span（traces 开启则走 `/v1/traces`；否则降级为 logs 事件；默认不阻塞被装饰方法）。

## OpenTelemetry bridge (for AxFlow / @opentelemetry/api)

本包提供一个轻量 `@opentelemetry/api` bridge（不依赖 SDK），用于把：
- tracing spans → 通过 `otlp.traceSync(...)`（best-effort, non-blocking）导出
- metrics → 通过 `otlp.metricSync(...)`（best-effort, non-blocking）导出

```ts
import { flow } from '@ax-llm/ax'
import { context } from '@opentelemetry/api'
import { createOtlpOtelMeter, createOtlpOtelTracer } from 'pluxel-plugin-otlp/otel'

const tracer = createOtlpOtelTracer(otlp, { tracerName: 'axflow' })
const meter = createOtlpOtelMeter(otlp, { meterName: 'axflow' })

const wf = flow<{ userQuestion: string }>()
  .node('summarizer', 'documentText:string -> summaryText:string')

const out = await wf.forward(llm, { userQuestion: 'hi' }, {
  tracer,
  meter,
  traceContext: context.active(), // OpenTelemetry Context (not a Span)
})
```

## Routing (multi-destination OTLP)

单个 `OtlpHub` 可以按 caller plugin id/name 路由到多个目标端点：

```ts
host.cfg('OtlpHub').set({
  core: { enabled: true, endpoint: 'http://localhost:4318' }, // default target
  signals: { traces: true, metrics: true, logs: false },
  targets: [
    { id: 'ai', endpoint: 'http://otel-collector-ai:4318' },
    { id: 'payments', endpoint: 'http://otel-collector-payments:4318' },
  ],
  routing: {
    byCallerId: {
      UniverAI: 'ai',
      Billing: 'payments',
    },
  },
})
```

## Traces：用法合集

#### 1) 直接 push span（`trace()`）

```ts
await otlp.trace({
  name: 'db.query',
  kind: 'client',
  attributes: { dbSystem: 'postgres', ok: true },
  startTsMs: Date.now(),
  endTsMs: Date.now() + 5,
})
```

#### 2) 句柄式（`span()`）

```ts
const span = otlp.span('cache.get', { attributes: { key: 'k1' } })
span.event('hit', { ok: true })
await span.end({ status: 'ok' })
```

## Metrics：用法合集

#### 1) 直接 push（`metric()`）

```ts
await otlp.metric({ type: 'counter', name: 'req_total', value: 1, attributes: { route: '/ping' } })
await otlp.metric({ type: 'gauge', name: 'rss_bytes', value: 123_456 })
await otlp.metric({ type: 'histogram', name: 'latency_ms', value: 42, bounds: [5, 10, 25, 50, 100, 250, 500, 1000] })
```

#### 2) 句柄式（`counter/gauge/histogram`）

```ts
const reqTotal = otlp.counter('req_total', { attributes: { service: 'api' } })
await reqTotal.add(1, { route: '/ping' })

const rss = otlp.gauge('rss_bytes')
await rss.set(123_456)

const latency = otlp.histogram('latency_ms', { bounds: [5, 10, 25, 50, 100, 250, 500, 1000] })
await latency.record(42, { route: '/ping' })
```

## Valibot Form：二选一配置（Type Switch / Segmented）

当你需要在宿主 UI 里做“复制二选一”的配置（例如 exporter 类型：`http-json` vs `grpc`），推荐用 discriminator union + UI meta：

```ts
import { f, v } from '@pluxel/hmr/config'

const HttpJsonSchema = v.object({
  type: v.literal('http-json'),
  endpoint: v.string(),
  headers: v.optional(v.record(v.string(), v.string()), {}),
})

const GrpcSchema = v.object({
  type: v.literal('grpc'),
  endpoint: v.string(),
  insecure: v.optional(v.boolean(), true),
})

export const TypeSwitchSchema = v.pipe(
  v.variant('type', [HttpJsonSchema, GrpcSchema]),
  f.formMeta({ label: '类型切换' }),
  f.unionMeta({
    discriminator: 'type',
    branchLabels: { 'http-json': 'HTTP/JSON', grpc: 'gRPC' },
    branchDescriptions: { 'http-json': '更易调试', grpc: '更高效（需实现）' },
    variant: 'segmented', // 分段控件
  }),
)
```
