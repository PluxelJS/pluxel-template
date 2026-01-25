import { describe, expect, it } from 'bun:test'
import { BasePlugin, Plugin, withTestHost } from '@pluxel/core/test'

import { Otlp, OtlpHub } from '../src/index.js'
import { OtlpSpan } from '../src/decorators.js'

function startCollector() {
	const received: Array<{ path: string; text: string; json: any | null }> = []
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url)
			const text = await req.text()
			let json: any | null = null
			if (text) {
				try {
					json = JSON.parse(text)
				} catch {
					json = null
				}
			}
			received.push({ path: url.pathname, text, json })
			return new Response('', { status: 200 })
		},
	})
	return { server, received, endpoint: `http://127.0.0.1:${server.port}` }
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
		const { server, received, endpoint } = startCollector()
		try {
			await withTestHost(async (host) => {
				await (host.config as any).ready?.catch(() => undefined)
				host.registerAll(OtlpHub, OtlpCaller)
				host.setConfig(OtlpHub, {
					core: { enabled: true, endpoint },
					signals: { logs: true, traces: true, metrics: true },
					batch: { flushIntervalMs: 5, maxBatchRecords: 1, maxInflight: 1 },
					queueCfg: { overflow: 'block', maxQueuedRecords: 10_000, maxQueuedBytes: 10_000_000 },
				})
				expect(host.config.getConfig<any>('OtlpHub').core?.enabled).toBe(true)
				await host.commitStrict()

				const hub = host.getOrThrow(OtlpHub)
				expect(hub.ctx.pluginInfo.id).toBe('OtlpHub')
				expect(host.config).toBe(hub.ctx.configService)
				expect(hub.ctx.configService.getConfig<any>().core?.enabled).toBe(true)

				const st = host.getOrThrow(Otlp).stats()
				expect(st.enabled).toBe(true)
				expect(st.signals.logs.enabled).toBe(true)
				expect(st.signals.traces.enabled).toBe(true)
				expect(st.signals.metrics.enabled).toBe(true)

				await host.getOrThrow(OtlpCaller).emitAll()
				await host.getOrThrow(Otlp).flush()
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
			server.stop()
		}
	})

	it('@OtlpSpan emits trace span when traces enabled', async () => {
		const { server, received, endpoint } = startCollector()
		try {
			await withTestHost(async (host) => {
				await (host.config as any).ready?.catch(() => undefined)
				host.registerAll(OtlpHub, Decorated)
				host.setConfig(OtlpHub, {
					core: { enabled: true, endpoint },
					signals: { logs: true, traces: true, metrics: false },
					batch: { flushIntervalMs: 5, maxBatchRecords: 1, maxInflight: 1 },
					queueCfg: { overflow: 'block', maxQueuedRecords: 10_000, maxQueuedBytes: 10_000_000 },
				})
				expect(host.config.getConfig<any>('OtlpHub').core?.enabled).toBe(true)
				await host.commitStrict()

				const hub = host.getOrThrow(OtlpHub)
				expect(hub.ctx.pluginInfo.id).toBe('OtlpHub')
				expect(host.config).toBe(hub.ctx.configService)
				expect(hub.ctx.configService.getConfig<any>().core?.enabled).toBe(true)

				const st = host.getOrThrow(Otlp).stats()
				expect(st.enabled).toBe(true)
				expect(st.signals.traces.enabled).toBe(true)

				await host.getOrThrow(Decorated).run()
				await host.getOrThrow(Otlp).flush()
			})

			const traces = received.filter((r) => r.path === '/v1/traces')
			expect(traces.length).toBeGreaterThanOrEqual(1)
			const span = traces[0]!.json.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
			expect(span.name).toBe('Decorated.run')
		} finally {
			server.stop()
		}
	})
})
