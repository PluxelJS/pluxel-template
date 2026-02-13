import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { OtlpHub } from 'pluxel-plugin-otlp'
import { OtlpViewerRpc } from './rpc'
import { OtlpViewerConfigSchema, type OtlpViewerConfig } from './config'
import { OtlpViewerDuckDbStore } from './store'

@Plugin({ name: 'OtlpViewer', type: 'service' })
export class OtlpViewer extends BasePlugin {
	@Config(OtlpViewerConfigSchema)
	private config!: OtlpViewerConfig

	private store: OtlpViewerDuckDbStore | null = null

	constructor(private readonly otlpHub: OtlpHub) {
		super()
	}

	async init(_abort: AbortSignal): Promise<void> {
		if (this.config.enabled) {
			try {
				this.store = await OtlpViewerDuckDbStore.create(this.config)
				this.ctx.effects.defer(() => void this.store?.close())

				const off = this.otlpHub.registerTap({
					onLogs: (items, meta) => this.store?.ingestLogs(items, meta),
					onTraces: (items, meta) => this.store?.ingestSpans(items, meta),
					onMetrics: (items, meta) => this.store?.ingestMetrics(items, meta),
				})
				this.ctx.effects.defer(off)
			} catch (error) {
				this.store = null
				this.ctx.logger.warn('[otlp-viewer] failed to initialize DuckDB store (capture disabled)', { error })
			}
		} else {
			this.store = null
		}

		const hmr = (this.ctx.config as any)?.hmrService as { entries?: unknown } | undefined
		if (!hmr || !Array.isArray(hmr.entries) || hmr.entries.length === 0) return

		const extUi = this.ctx.ext?.ui
		if (extUi) {
			try {
				extUi.register({ entryPath: './ui/index.tsx' })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (message.includes('无法定位插件目录')) {
					this.ctx.logger?.warn?.('[otlp-viewer] UI extension registration skipped', { error })
				} else {
					throw error
				}
			}
		}

		this.ctx.ext?.rpc?.registerExtension(() => new OtlpViewerRpc(this))
	}

	async seed(kind: 'logs' | 'traces' | 'metrics' | 'mixed', count?: number): Promise<{ inserted: number }> {
		if (!this.store) return { inserted: 0 }
		const n = Math.max(1, Math.min(5000, Math.floor(Number(count ?? 50) || 50)))

		const now = Date.now()
		let inserted = 0

		const seedLogs = async () => {
			for (let i = 0; i < n; i++) {
				const level = i % 17 === 0 ? 'error' : i % 7 === 0 ? 'warn' : 'info'
				await this.otlpHub.log({
					level: level as any,
					body: `demo log #${i}`,
					attributes: { demo: true, i, feature: 'otlp-viewer', seed: kind },
					tsMs: now - (n - i) * 25,
				})
				inserted++
			}
		}

		const seedTraces = async () => {
			for (let i = 0; i < n; i++) {
				const span = this.otlpHub.span(`demo.span.${i}`, { kind: 'internal', attributes: { demo: true, i, seed: kind } })
				span.event('evt', { i })
				await this.otlpHub.log({
					level: i % 13 === 0 ? 'error' : 'info',
					body: `demo log for span #${i}`,
					traceId: span.traceId,
					spanId: span.spanId,
					attributes: { demo: true, i, correlated: true, seed: kind },
					tsMs: now - (n - i) * 25 + 5,
				})
				inserted++
				await span.end({ status: i % 13 === 0 ? 'error' : 'ok', error: i % 13 === 0 ? new Error('demo error') : undefined })
				inserted++
			}
		}

		const seedMetrics = async () => {
			for (let i = 0; i < n; i++) {
				const t = i % 3 === 0 ? 'counter' : i % 3 === 1 ? 'gauge' : 'histogram'
				if (t === 'counter') {
					await this.otlpHub.metric({ type: 'counter', name: 'demo_counter_total', value: 1, attributes: { demo: true, i, seed: kind }, tsMs: now - (n - i) * 50 })
				} else if (t === 'gauge') {
					await this.otlpHub.metric({ type: 'gauge', name: 'demo_gauge_value', value: (i % 100) / 10, attributes: { demo: true, i, seed: kind }, tsMs: now - (n - i) * 50 })
				} else {
					await this.otlpHub.metric({ type: 'histogram', name: 'demo_latency_ms', value: (i % 200) + 1, bounds: [5, 10, 25, 50, 100, 250], attributes: { demo: true, i, seed: kind }, tsMs: now - (n - i) * 50 })
				}
				inserted++
			}
		}

		if (kind === 'logs') await seedLogs()
		else if (kind === 'traces') await seedTraces()
		else if (kind === 'metrics') await seedMetrics()
		else {
			await seedLogs()
			await seedTraces()
			await seedMetrics()
		}

		await this.store.flush()
		return { inserted }
	}

	getStore(): OtlpViewerDuckDbStore {
		if (!this.store) throw new Error('[otlp-viewer] store not enabled/initialized')
		return this.store
	}

	getStoreOptional(): OtlpViewerDuckDbStore | null {
		return this.store
	}
}

export default OtlpViewer
