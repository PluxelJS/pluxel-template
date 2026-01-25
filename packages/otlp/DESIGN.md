# OTLP Plugin (Design Notes)

Goal: expose a small, efficient OTLP exporter service for the Pluxel/HMR plugin runtime.

Status (2026-01-23):
- ✅ Implemented: OTLP/HTTP JSON **Logs** exporter (`/v1/logs`)
- ✅ Implemented: OTLP/HTTP JSON **Traces** exporter (`/v1/traces`)
- ✅ Implemented: OTLP/HTTP JSON **Metrics** exporter (`/v1/metrics`)
- ✅ Implemented: `@OtlpSpan()` emits trace spans when traces enabled (fallback to logs when disabled)

## Core ideas

- **Single runtime token**: other plugins depend on `Otlp` and do not care about transport / batching details.
- **Config-first**: enable/endpoint/batching/backpressure are driven by `configs.use(schema)` config schemas with safe defaults.
- **Bounded memory**: queue is capped; overflow behavior is explicit (`dropNewest` / `dropOldest` / `block`).
- **Batching on a tight loop**: flush is triggered by size and interval; at most `maxInflight` requests.

## Public surface (kept intentionally small)

- `await otlp.log(record | record[])` (Logs)
- `otlp.logger({ attributes? })` → `OtlpLogger` convenience wrapper (Logs)
- `await otlp.trace(span | span[])` (Traces)
- `otlp.span(name, opts?)` → `OtlpSpanHandle` (Traces, handle-style)
- `await otlp.metric(point | point[])` (Metrics)
- `otlp.counter/gauge/histogram(...)` helpers (Metrics)
- `await otlp.flush()` (best-effort; drains queue deterministically)
- `otlp.stats()` (queue / drops / lastError)

### Why “small surface” matters

- Plugins should not import (or be forced to import) OpenTelemetry SDKs; the runtime provides a single `Otlp` token.
- The exporter should be “safe by default”: disabled unless configured; bounded memory even under failures.
- The runtime should choose the transport (OTLP/HTTP JSON now; other transports later) without affecting callers.

## Signals & API shape

Keep the ergonomics consistent across signals:

- Logs: `otlp.log(...)` + `otlp.logger(...)` (already done)
- Traces: `otlp.trace(...)` + `otlp.span(...)` (+ decorators)
- Metrics: `otlp.metric(...)` + `otlp.counter/gauge/histogram`

All options should reuse the same “bounded queue + batching + backpressure” core.

## Config UX (valibot-form)

We want configs to be:
- Machine-validated (valibot)
- Host-renderable (form meta)
- Easy to switch between mutually-exclusive sub-configs (discriminator union)

Example pattern: “Type switch” (segmented control) for transport selection.

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
    variant: 'segmented',
  }),
)
```
