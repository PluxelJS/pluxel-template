import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BasePlugin, Plugin, withHost } from '@pluxel/test'

import { Otlp, OtlpHub } from '../src/index.js'
import { OtlpSpan } from '../src/decorators.js'
import { createOtlpOtelMeter, createOtlpOtelTracer } from '../src/otel.js'

async function startCollector() {
	const received: Array<{ path: string; text: string; json: any | null }> = []

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
		const chunks: Buffer[] = []
		req.on('data', (c) => chunks.push(Buffer.from(c)))
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf-8')
			let json: any | null = null
			if (text) {
				try {
					json = JSON.parse(text)
				} catch {
					json = null
				}
			}
			received.push({ path: url.pathname, text, json })
			res.statusCode = 200
			res.end('')
		})
	})

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const addr = server.address() as AddressInfo
	const endpoint = `http://127.0.0.1:${addr.port}`

	return {
		received,
		endpoint,
		stop: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

@Plugin({ name: 'OtlpCaller', type: 'service' })
class OtlpCaller extends BasePlugin {
	constructor(private readonly otlp: Otlp) {
		super()
	}

	async emitAll() {
		await this.otlp.log({ level: 'info', body: 'hello', attributes: { a: 1 } })
		await this.otlp.trace({ name: 'span1', kind: 'internal', attributes: { ok: true } })
		await this.otlp.metric({ type: 'counter', name: 'req_total', value: 1, attributes: { route: '/ping' } })
		await this.otlp.metric({ type: 'gauge', name: 'rss_bytes', value: 123_456 })
		await this.otlp.metric({ type: 'histogram', name: 'latency_ms', value: 42, bounds: [5, 10, 25, 50, 100] })
	}
}

@Plugin({ name: 'Decorated', type: 'service' })
class Decorated extends BasePlugin {
	constructor(private readonly _otlp: Otlp) {
		super()
	}

	@OtlpSpan({ name: 'Decorated.run' })
	async run() {
		return 'ok'
	}
}

describe('pluxel-plugin-otlp: logs/traces/metrics (OTLP/HTTP JSON)', () => {
	it('exports logs/traces/metrics to /v1/* and flush drains', async () => {
		const { stop, received, endpoint } = await startCollector()
		try {
			await withHost(async (host) => {
				await host.ctx.configService.ready
				host.cfg('OtlpHub').set({
					core: { enabled: true, endpoint },
					signals: { logs: true, traces: true, metrics: true },
					batch: { flushIntervalMs: 5, maxBatchRecords: 1, maxInflight: 1 },
					queueCfg: { overflow: 'block', maxQueuedRecords: 10_000, maxQueuedBytes: 10_000_000 },
				})
				expect(host.ctx.configService.getRawConfig<any>('OtlpHub').core?.enabled).toBe(true)

				host.add([OtlpHub, OtlpCaller])
				await host.commit()

				const hub = host.require(OtlpHub)
				expect(hub.ctx.pluginInfo.id).toBe('OtlpHub')
				expect(host.ctx.configService).toBe(hub.ctx.configService)
				expect(hub.ctx.configService.getRawConfig<any>().core?.enabled).toBe(true)

				const st = host.require(Otlp).stats()
				expect(st.enabled).toBe(true)
				expect(st.signals.logs.enabled).toBe(true)
				expect(st.signals.traces.enabled).toBe(true)
				expect(st.signals.metrics.enabled).toBe(true)

				await host.require(OtlpCaller).emitAll()
				await host.require(Otlp).flush()
			})

			const paths = received.map((r) => r.path)
			expect(paths).toContain('/v1/logs')
			expect(paths).toContain('/v1/traces')
			expect(paths).toContain('/v1/metrics')

			const logs = received.find((r) => r.path === '/v1/logs')!.json
			expect(logs.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.length).toBe(1)

			const traces = received.find((r) => r.path === '/v1/traces')!.json
			const span = traces.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
			expect(typeof span.traceId).toBe('string')
			expect(typeof span.spanId).toBe('string')
			expect(span.name).toBe('span1')
			expect(typeof span.startTimeUnixNano).toBe('string')
			expect(typeof span.endTimeUnixNano).toBe('string')

			const metricReqs = received.filter((r) => r.path === '/v1/metrics').map((r) => r.json).filter(Boolean)
			const totalMetrics = metricReqs.reduce((acc, j) => {
				const n = j.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics?.length ?? 0
				return acc + Number(n)
			}, 0)
			expect(totalMetrics).toBeGreaterThanOrEqual(3)
		} finally {
			await stop()
		}
	})

	it('@OtlpSpan emits trace span when traces enabled', async () => {
		const { stop, received, endpoint } = await startCollector()
		try {
			await withHost(async (host) => {
				await host.ctx.configService.ready
				host.cfg('OtlpHub').set({
					core: { enabled: true, endpoint },
					signals: { logs: true, traces: true, metrics: false },
					batch: { flushIntervalMs: 5, maxBatchRecords: 1, maxInflight: 1 },
					queueCfg: { overflow: 'block', maxQueuedRecords: 10_000, maxQueuedBytes: 10_000_000 },
				})
				expect(host.ctx.configService.getRawConfig<any>('OtlpHub').core?.enabled).toBe(true)

				host.add([OtlpHub, Decorated])
				await host.commit()

				const hub = host.require(OtlpHub)
				expect(hub.ctx.pluginInfo.id).toBe('OtlpHub')
				expect(host.ctx.configService).toBe(hub.ctx.configService)
				expect(hub.ctx.configService.getRawConfig<any>().core?.enabled).toBe(true)

				const st = host.require(Otlp).stats()
				expect(st.enabled).toBe(true)
				expect(st.signals.traces.enabled).toBe(true)

				await host.require(Decorated).run()
				await host.require(Otlp).flush()
			})

			const traces = received.filter((r) => r.path === '/v1/traces')
			expect(traces.length).toBeGreaterThanOrEqual(1)
			const span = traces[0]!.json.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
			expect(span.name).toBe('Decorated.run')
		} finally {
			await stop()
		}
	})

	it('OpenTelemetry bridge (Tracer/Meter) exports spans + metrics synchronously', async () => {
		const { stop, received, endpoint } = await startCollector()
		@Plugin({ name: 'OtelCaller', type: 'service' })
		class OtelCaller extends BasePlugin {
			constructor(private readonly otlp: Otlp) {
				super()
			}

			emit() {
				const tracer = createOtlpOtelTracer(this.otlp, { tracerName: 'axflow' })
				const meter = createOtlpOtelMeter(this.otlp, { meterName: 'axflow' })
				const span = tracer.startSpan('otel.span')
				span.setAttribute('ok', true as any)
				span.addEvent('evt', { a: 1 } as any)
				span.end()

				const reqTotal = meter.createCounter('otel_req_total')
				reqTotal.add(1, { route: '/ping' } as any)
			}
		}

		try {
			await withHost(async (host) => {
				await host.ctx.configService.ready
				host.cfg('OtlpHub').set({
					core: { enabled: true, endpoint },
					signals: { logs: false, traces: true, metrics: true },
					batch: { flushIntervalMs: 5, maxBatchRecords: 256, maxInflight: 1 },
					queueCfg: { overflow: 'block', maxQueuedRecords: 10_000, maxQueuedBytes: 10_000_000 },
				})

				host.add([OtlpHub, OtelCaller])
				await host.commit()

				host.require(OtelCaller).emit()
				await host.require(Otlp).flush()
			})

			const traces = received.find((r) => r.path === '/v1/traces')!.json
			const span = traces.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
			expect(span.name).toBe('otel.span')

			const metricReqs = received.filter((r) => r.path === '/v1/metrics').map((r) => r.json).filter(Boolean)
			const names = metricReqs.flatMap((j) => j.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics?.map((m: any) => m.name) ?? [])
			expect(names).toContain('otel_req_total')
		} finally {
			await stop()
		}
	})

	it('routes by callerId to different OTLP targets', async () => {
		const a = await startCollector()
		const b = await startCollector()
		try {
			@Plugin({ name: 'CallerA', type: 'service' })
			class CallerA extends BasePlugin {
				constructor(private readonly otlp: Otlp) {
					super()
				}
				async emit() {
					await this.otlp.log({ level: 'info', body: 'a' })
				}
			}

			@Plugin({ name: 'CallerB', type: 'service' })
			class CallerB extends BasePlugin {
				constructor(private readonly otlp: Otlp) {
					super()
				}
				async emit() {
					await this.otlp.log({ level: 'info', body: 'b' })
				}
			}

			await withHost(async (host) => {
				await host.ctx.configService.ready
				host.cfg('OtlpHub').set({
					core: { enabled: true, endpoint: a.endpoint },
					signals: { logs: true, traces: false, metrics: false },
					targets: [{ id: 'b', endpoint: b.endpoint }],
					routing: { byCallerId: { CallerB: 'b' } },
					batch: { flushIntervalMs: 5, maxBatchRecords: 1, maxInflight: 1 },
					queueCfg: { overflow: 'block', maxQueuedRecords: 10_000, maxQueuedBytes: 10_000_000 },
				})

				host.add([OtlpHub, CallerA, CallerB])
				await host.commit()

				await host.require(CallerA).emit()
				await host.require(CallerB).emit()
				await host.require(Otlp).flush()
			})

			expect(a.received.some((r) => r.path === '/v1/logs')).toBe(true)
			expect(b.received.some((r) => r.path === '/v1/logs')).toBe(true)
		} finally {
			await a.stop()
			await b.stop()
		}
	})
})
