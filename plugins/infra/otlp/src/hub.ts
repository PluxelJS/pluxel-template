import type { Context } from '@pluxel/hmr'
import { Plugin } from '@pluxel/hmr'
import { f, v } from '@pluxel/hmr/config'

import type {
	OtlpAttributes,
	OtlpLogLevel,
	OtlpLogRecordInput,
	OtlpMetricPointInput,
	OtlpSignal,
	OtlpSignalStats,
	OtlpSpanHandle,
	OtlpSpanInput,
	OtlpSpanKind,
	OtlpSpanStatus,
	OtlpStats,
} from './core.js'
import { Otlp } from './core.js'

type OverflowMode = 'dropNewest' | 'dropOldest' | 'block'
type QueueItem = { json: string; bytes: number }
type DestinationState = {
	endpoint: string
	headers: Record<string, string>
	timeoutMs: number
	logsQ: OtlpHttpJsonQueue
	tracesQ: OtlpHttpJsonQueue
	metricsQ: OtlpHttpJsonQueue
}

const ENCODER = new TextEncoder()

export const OtlpHubCoreCfgSchema = v.object({
	enabled: v.optional(v.boolean(), false),
	endpoint: v.optional(v.string(), 'http://localhost:4318'),
	headers: v.optional(v.record(v.string(), v.string()), {}),
	timeoutMs: v.optional(v.number(), 10_000),
})

export const OtlpHubTargetCfgSchema = v.object({
	id: v.pipe(v.string(), f.formMeta({ label: 'Target ID', description: 'Used by routing.byCallerId/byCallerName.' })),
	endpoint: v.pipe(v.string(), f.formMeta({ label: 'Endpoint', description: 'Collector base URL (e.g. http://localhost:4318).' })),
	headers: v.optional(v.record(v.string(), v.string()), {}),
	timeoutMs: v.optional(v.number(), 10_000),
})

export const OtlpHubTargetsCfgSchema = v.pipe(
	v.optional(v.array(OtlpHubTargetCfgSchema), []),
	f.formMeta({ label: 'Targets', description: 'Additional OTLP destinations for caller-based routing.' }),
)

export const OtlpHubRoutingCfgSchema = v.pipe(
	v.object({
		defaultTargetId: v.optional(v.string(), ''),
		byCallerId: v.optional(v.record(v.string(), v.string()), {}),
		byCallerName: v.optional(v.record(v.string(), v.string()), {}),
	}),
	f.formMeta({ label: 'Routing', description: 'Route telemetry by caller plugin id/name to a target.' }),
)

export const OtlpHubSignalsCfgSchema = v.object({
	logs: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '启用 Logs', description: 'OTLP /v1/logs' }),
		f.booleanMeta({}),
	),
	traces: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '启用 Traces', description: 'OTLP /v1/traces' }),
		f.booleanMeta({}),
	),
	metrics: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '启用 Metrics', description: 'OTLP /v1/metrics' }),
		f.booleanMeta({}),
	),
})

export const OtlpHubResourceCfgSchema = v.object({
	serviceName: v.optional(v.string(), 'pluxel'),
	serviceNamespace: v.optional(v.string(), ''),
	serviceVersion: v.optional(v.string(), ''),
	resourceAttributes: v.optional(v.record(v.string(), v.any()), {}),
})

export const OtlpHubScopeCfgSchema = v.object({
	name: v.optional(v.string(), 'pluxel'),
	version: v.optional(v.string(), ''),
})

export const OtlpHubBatchCfgSchema = v.object({
	flushIntervalMs: v.optional(v.number(), 1000),
	maxBatchRecords: v.optional(v.number(), 256),
	maxBatchBytes: v.optional(v.number(), 256 * 1024),
	maxInflight: v.optional(v.number(), 1),
})

export const OtlpHubQueueCfgSchema = v.object({
	maxQueuedRecords: v.optional(v.number(), 5000),
	maxQueuedBytes: v.optional(v.number(), 2 * 1024 * 1024),
	overflow: v.optional(v.picklist(['dropNewest', 'dropOldest', 'block'] as const), 'dropNewest'),
})

export type OtlpHubCoreConfig = v.InferOutput<typeof OtlpHubCoreCfgSchema>
export type OtlpHubBatchConfig = v.InferOutput<typeof OtlpHubBatchCfgSchema>
export type OtlpHubQueueConfig = v.InferOutput<typeof OtlpHubQueueCfgSchema>
export type OtlpHubSignalsConfig = v.InferOutput<typeof OtlpHubSignalsCfgSchema>
export type OtlpHubTargetConfig = v.InferOutput<typeof OtlpHubTargetCfgSchema>
export type OtlpHubRoutingConfig = v.InferOutput<typeof OtlpHubRoutingCfgSchema>

export const OtlpHubConfigSchemas = {
	core: OtlpHubCoreCfgSchema,
	targets: OtlpHubTargetsCfgSchema,
	routing: OtlpHubRoutingCfgSchema,
	signals: OtlpHubSignalsCfgSchema,
	resourceCfg: OtlpHubResourceCfgSchema,
	scopeCfg: OtlpHubScopeCfgSchema,
	batch: OtlpHubBatchCfgSchema,
	queueCfg: OtlpHubQueueCfgSchema,
} as const

function normalizeEndpoint(raw: string): string {
	const s = String(raw ?? '').trim()
	if (!s) throw new Error('[otlp] endpoint must be non-empty')
	return s.replace(/\/+$/, '')
}

function toUnixNano(tsMs: number): string {
	return (BigInt(Math.floor(tsMs)) * 1_000_000n).toString()
}

function randomHex(bytes: number): string {
	try {
		const buf = new Uint8Array(bytes)
		crypto.getRandomValues(buf)
		return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
	} catch {
		let out = ''
		for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
		return out
	}
}

function severityNumber(level: OtlpLogLevel): number {
	switch (level) {
		case 'trace':
			return 1
		case 'debug':
			return 5
		case 'info':
			return 9
		case 'warn':
			return 13
		case 'error':
			return 17
		case 'fatal':
			return 21
	}
}

function spanKindNumber(kind: OtlpSpanKind | undefined): number {
	switch (kind ?? 'internal') {
		case 'internal':
			return 1
		case 'server':
			return 2
		case 'client':
			return 3
		case 'producer':
			return 4
		case 'consumer':
			return 5
	}
}

function statusCodeNumber(status: OtlpSpanStatus | undefined): number {
	switch (status ?? 'unset') {
		case 'unset':
			return 0
		case 'ok':
			return 1
		case 'error':
			return 2
	}
}

function temporalityNumber(t: 'delta' | 'cumulative' | undefined): number {
	switch (t ?? 'cumulative') {
		case 'delta':
			return 1
		case 'cumulative':
			return 2
	}
}

function toAnyValue(value: unknown): any {
	if (value === null || value === undefined) return { stringValue: '' }
	if (typeof value === 'string') return { stringValue: value }
	if (typeof value === 'boolean') return { boolValue: value }
	if (typeof value === 'bigint') return { intValue: value.toString() }
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) return { stringValue: String(value) }
		if (Number.isInteger(value)) return { intValue: String(value) }
		return { doubleValue: value }
	}
	if (Array.isArray(value)) return { arrayValue: { values: value.map((v) => toAnyValue(v)) } }
	if (typeof value === 'object') {
		const entries = Object.entries(value as any)
		return {
			kvlistValue: {
				values: entries
					.filter(([k]) => !!k)
					.map(([k, v]) => ({ key: String(k), value: toAnyValue(v) })),
			},
		}
	}
	return { stringValue: String(value) }
}

function toKeyValues(attrs: OtlpAttributes | undefined): Array<{ key: string; value: any }> {
	if (!attrs) return []
	const keys = Object.keys(attrs).sort()
	const out: Array<{ key: string; value: any }> = []
	for (const key of keys) {
		if (!key) continue
		out.push({ key, value: toAnyValue((attrs as any)[key]) })
	}
	return out
}

function toNumberPointValue(n: number): any {
	if (!Number.isFinite(n)) return { asDouble: 0 }
	if (Number.isInteger(n)) return { asInt: String(n) }
	return { asDouble: n }
}

function itemBytes(json: string): number {
	return ENCODER.encode(json).byteLength
}

function logRecordToItem(record: OtlpLogRecordInput, baseAttrs: OtlpAttributes): QueueItem {
	const tsMs = typeof record.tsMs === 'number' ? record.tsMs : Date.now()
	const level: OtlpLogLevel = record.level ?? 'info'

	const attributes = toKeyValues({ ...baseAttrs, ...(record.attributes ?? {}) })
	const payload: any = {
		timeUnixNano: toUnixNano(tsMs),
		observedTimeUnixNano: toUnixNano(Date.now()),
		severityNumber: severityNumber(level),
		severityText: level.toUpperCase(),
		body: toAnyValue(record.body),
		...(attributes.length ? { attributes } : {}),
	}

	const json = JSON.stringify(payload)
	return { json, bytes: itemBytes(json) }
}

function spanToItem(span: OtlpSpanInput, baseAttrs: OtlpAttributes): QueueItem {
	const startTsMs = typeof span.startTsMs === 'number' ? span.startTsMs : Date.now()
	const endTsMs = typeof span.endTsMs === 'number' ? span.endTsMs : Date.now()
	const status: OtlpSpanStatus = span.status ?? (span.error ? 'error' : 'unset')
	const errorMessage = span.error instanceof Error ? span.error.message : span.error ? String(span.error) : ''

	const traceId = (span.traceId ?? '').trim() || randomHex(16)
	const spanId = (span.spanId ?? '').trim() || randomHex(8)
	const parentSpanId = (span.parentSpanId ?? '').trim()

	const attributes = toKeyValues({ ...baseAttrs, ...(span.attributes ?? {}) })
	const events = (span.events ?? []).map((e) => {
		const tsMs = typeof e.tsMs === 'number' ? e.tsMs : endTsMs
		const attrs = toKeyValues(e.attributes)
		return {
			timeUnixNano: toUnixNano(tsMs),
			name: e.name,
			...(attrs.length ? { attributes: attrs } : {}),
		}
	})

	const payload: any = {
		traceId,
		spanId,
		...(parentSpanId ? { parentSpanId } : {}),
		name: span.name,
		kind: spanKindNumber(span.kind),
		startTimeUnixNano: toUnixNano(startTsMs),
		endTimeUnixNano: toUnixNano(endTsMs),
		...(attributes.length ? { attributes } : {}),
		...(events.length ? { events } : {}),
		...(status !== 'unset' || errorMessage
			? { status: { code: statusCodeNumber(status), ...(errorMessage ? { message: errorMessage } : {}) } }
			: {}),
	}

	const json = JSON.stringify(payload)
	return { json, bytes: itemBytes(json) }
}

function metricPointToItem(point: OtlpMetricPointInput, baseAttrs: OtlpAttributes): QueueItem {
	const tsMs = typeof point.tsMs === 'number' ? point.tsMs : Date.now()
	const attrs = toKeyValues({ ...baseAttrs, ...(point.attributes ?? {}) })
	const timeUnixNano = toUnixNano(tsMs)
	// We default to delta temporality for push-style points; for exporters that require a start time,
	// we set startTimeUnixNano = timeUnixNano (best-effort; callers can provide their own cadence later).
	const dataPointBase: any = {
		timeUnixNano,
		startTimeUnixNano: timeUnixNano,
		...(attrs.length ? { attributes: attrs } : {}),
	}

	let metric: any
	if (point.type === 'counter') {
		metric = {
			name: point.name,
			...(point.description ? { description: point.description } : {}),
			...(point.unit ? { unit: point.unit } : {}),
			sum: {
				aggregationTemporality: temporalityNumber(point.temporality ?? 'delta'),
				isMonotonic: point.monotonic ?? true,
				dataPoints: [{ ...dataPointBase, ...toNumberPointValue(point.value) }],
			},
		}
	} else if (point.type === 'gauge') {
		metric = {
			name: point.name,
			...(point.description ? { description: point.description } : {}),
			...(point.unit ? { unit: point.unit } : {}),
			gauge: { dataPoints: [{ ...dataPointBase, ...toNumberPointValue(point.value) }] },
		}
	} else {
		const bounds = (point.bounds ?? []).slice().map((n) => Number(n)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
		const bucketCounts = new Array(bounds.length + 1).fill('0')
		let idx = bounds.findIndex((b) => point.value <= b)
		if (idx < 0) idx = bounds.length
		bucketCounts[idx] = '1'

		metric = {
			name: point.name,
			...(point.description ? { description: point.description } : {}),
			...(point.unit ? { unit: point.unit } : {}),
			histogram: {
				aggregationTemporality: temporalityNumber(point.temporality ?? 'delta'),
				dataPoints: [
					{
						...dataPointBase,
						count: '1',
						sum: Number.isFinite(point.value) ? point.value : 0,
						bucketCounts,
						explicitBounds: bounds,
						min: Number.isFinite(point.value) ? point.value : 0,
						max: Number.isFinite(point.value) ? point.value : 0,
					},
				],
			},
		}
	}

	const json = JSON.stringify(metric)
	return { json, bytes: itemBytes(json) }
}

class OtlpHttpJsonQueue {
	private readonly signal: OtlpSignal
	private readonly enabled: boolean
	private readonly batch: OtlpHubBatchConfig
	private readonly queueCfg: OtlpHubQueueConfig
	private readonly timeoutMs: number
	private readonly buildBody: (items: readonly QueueItem[]) => string
	private readonly sendRequest: (body: string, timeoutMs: number) => Promise<void>
	private readonly warn: (message: string, meta: Record<string, unknown>) => void

	private flushTimeout: any = null
	private flushRunning = false
	private flushPending = false

	private inflight = 0
	private sentBatches = 0
	private sentItems = 0
	private dropped = 0
	private droppedQueueFull = 0
	private droppedDisabled = 0
	private lastError: OtlpSignalStats['lastError'] | undefined

	private queued: QueueItem[] = []
	private head = 0
	private queuedBytes = 0
	private waiting: Array<() => void> = []
	private idleWaiters: Array<() => void> = []

	constructor(opts: {
		signal: OtlpSignal
		enabled: boolean
		batch: OtlpHubBatchConfig
		queueCfg: OtlpHubQueueConfig
		timeoutMs: number
		buildBody: (items: readonly QueueItem[]) => string
		sendRequest: (body: string, timeoutMs: number) => Promise<void>
		warn: (message: string, meta: Record<string, unknown>) => void
	}) {
		this.signal = opts.signal
		this.enabled = opts.enabled
		this.batch = opts.batch
		this.queueCfg = opts.queueCfg
		this.timeoutMs = opts.timeoutMs
		this.buildBody = opts.buildBody
		this.sendRequest = opts.sendRequest
		this.warn = opts.warn
	}

	stats(): OtlpSignalStats {
		return {
			enabled: this.enabled,
			queued: this.queuedCount(),
			queuedBytes: this.queuedBytes,
			inflight: this.inflight,
			sentBatches: this.sentBatches,
			sentItems: this.sentItems,
			dropped: this.dropped,
			droppedQueueFull: this.droppedQueueFull,
			droppedDisabled: this.droppedDisabled,
			...(this.lastError ? { lastError: this.lastError } : {}),
		}
	}

	clearTimers(): void {
		if (!this.flushTimeout) return
		try {
			clearTimeout(this.flushTimeout)
		} finally {
			this.flushTimeout = null
		}
	}

	private notifyIdle(): void {
		if (this.inflight !== 0) return
		if (this.idleWaiters.length === 0) return
		const toRelease = this.idleWaiters.slice()
		this.idleWaiters.length = 0
		for (const r of toRelease) r()
	}

	private waitForIdle(): Promise<void> {
		if (this.inflight === 0) return Promise.resolve()
		return new Promise((resolve) => this.idleWaiters.push(resolve))
	}

	private releaseWaiters(): void {
		if (this.waiting.length === 0) return
		const toRelease = this.waiting.slice()
		this.waiting.length = 0
		for (const r of toRelease) r()
	}

	private shouldFlushNow(): boolean {
		const maxBatchRecords = Math.max(1, Math.floor(this.batch.maxBatchRecords))
		const maxBatchBytes = Math.max(1, Math.floor(this.batch.maxBatchBytes))
		return this.queuedCount() >= maxBatchRecords || this.queuedBytes >= maxBatchBytes
	}

	private scheduleFlush(): void {
		if (!this.enabled) return
		if (this.flushTimeout) return
		const delay = Math.max(0, Math.floor(this.batch.flushIntervalMs))
		this.flushTimeout = setTimeout(() => {
			this.flushTimeout = null
			this.kickFlush()
		}, delay)
	}

	private afterEnqueue(): void {
		if (!this.enabled) return
		if (this.shouldFlushNow()) {
			this.kickFlush()
			return
		}
		this.scheduleFlush()
	}

	private takeBatch(): QueueItem[] {
		const maxBatchRecords = Math.max(1, Math.floor(this.batch.maxBatchRecords))
		const maxBatchBytes = Math.max(1, Math.floor(this.batch.maxBatchBytes))

		const batch: QueueItem[] = []
		let bytes = 0
		while (batch.length < maxBatchRecords && this.queuedCount() > 0) {
			const next = this.queued[this.head]!
			if (batch.length > 0 && bytes + next.bytes > maxBatchBytes) break
			this.head++
			this.queuedBytes -= next.bytes
			batch.push(next)
			bytes += next.bytes
		}
		this.maybeCompact()
		return batch
	}

	private queuedCount(): number {
		return Math.max(0, this.queued.length - this.head)
	}

	private maybeCompact(): void {
		if (this.head === 0) return
		// Avoid O(n) shifts by compacting occasionally.
		if (this.head < 1024 && this.head < this.queued.length / 2) return
		this.queued = this.queued.slice(this.head)
		this.head = 0
	}

	private dropOldestOne(): void {
		if (this.queuedCount() === 0) return
		const removed = this.queued[this.head]!
		this.head++
		this.queuedBytes -= removed.bytes
		this.dropped++
		this.droppedQueueFull++
		this.maybeCompact()
	}

	private tryEnqueueInner(item: QueueItem, opts: { allowBlock: boolean }): { ok: boolean; shouldBlock: boolean } {
		if (!this.enabled) {
			this.dropped++
			this.droppedDisabled++
			return { ok: false, shouldBlock: false }
		}

		const maxItems = Math.max(1, Math.floor(this.queueCfg.maxQueuedRecords))
		const maxBytes = Math.max(1, Math.floor(this.queueCfg.maxQueuedBytes))
		const overflow = this.queueCfg.overflow as OverflowMode

		const fits = () => this.queuedCount() < maxItems && this.queuedBytes + item.bytes <= maxBytes

		if (fits()) {
			this.queued.push(item)
			this.queuedBytes += item.bytes
			this.afterEnqueue()
			return { ok: true, shouldBlock: false }
		}

		if (overflow === 'dropOldest') {
			while (this.queuedCount() > 0 && !fits()) this.dropOldestOne()
			if (!fits()) {
				this.dropped++
				this.droppedQueueFull++
				return { ok: false, shouldBlock: false }
			}
			this.queued.push(item)
			this.queuedBytes += item.bytes
			this.afterEnqueue()
			return { ok: true, shouldBlock: false }
		}

		if (overflow === 'block') {
			if (opts.allowBlock) return { ok: false, shouldBlock: true }
			this.dropped++
			this.droppedQueueFull++
			return { ok: false, shouldBlock: false }
		}

		// dropNewest
		this.dropped++
		this.droppedQueueFull++
		return { ok: false, shouldBlock: false }
	}

	tryEnqueue(item: QueueItem): boolean {
		return this.tryEnqueueInner(item, { allowBlock: false }).ok
	}

	async enqueue(item: QueueItem): Promise<void> {
		const res = this.tryEnqueueInner(item, { allowBlock: true })
		if (res.ok) return
		if (!res.shouldBlock) return

		const maxItems = Math.max(1, Math.floor(this.queueCfg.maxQueuedRecords))
		const maxBytes = Math.max(1, Math.floor(this.queueCfg.maxQueuedBytes))
		const fits = () => this.queuedCount() < maxItems && this.queuedBytes + item.bytes <= maxBytes

		await new Promise<void>((resolve) => {
			this.waiting.push(resolve)
			this.kickFlush()
		})

		if (!this.enabled) return
		if (fits()) {
			this.queued.push(item)
			this.queuedBytes += item.bytes
			this.afterEnqueue()
			return
		}

		this.dropped++
		this.droppedQueueFull++
	}

	async flush(): Promise<void> {
		if (!this.enabled) return
		this.clearTimers()

		while (this.inflight > 0) await this.waitForIdle()
		while (this.queuedCount() > 0) await this.kickFlush({ drain: true })
	}

	private async kickFlush(opts?: { drain?: boolean }): Promise<void> {
		this.clearTimers()
		if (!this.enabled) return
		if (this.queuedCount() === 0) return

		if (opts?.drain) {
			if (this.inflight !== 0) return
			const batch = this.takeBatch()
			this.releaseWaiters()
			if (batch.length === 0) return
			await this.sendBatchSafe(batch)
			if (this.queued.length > 0) return await this.kickFlush(opts)
			return
		}

		this.flushPending = true
		if (this.flushRunning) return
		this.flushRunning = true
		try {
			while (this.flushPending) {
				this.flushPending = false

				const maxInflight = Math.max(1, Math.floor(this.batch.maxInflight))
				while (this.inflight < maxInflight && this.queuedCount() > 0) {
					const batch = this.takeBatch()
					this.releaseWaiters()
					if (batch.length === 0) break
					void this.sendBatchSafe(batch).finally(() => {
						if (this.queuedCount() > 0) this.kickFlush()
						else this.notifyIdle()
					})
				}

				if (this.queuedCount() > 0) {
					if (!this.shouldFlushNow()) this.scheduleFlush()
				}
			}
		} finally {
			this.flushRunning = false
		}
	}

	private async sendBatchSafe(batch: QueueItem[]): Promise<void> {
		this.inflight++
		try {
			const body = this.buildBody(batch)
			await this.sendRequest(body, this.timeoutMs)
			this.sentBatches++
			this.sentItems += batch.length
		} catch (error) {
			this.lastError = {
				at: Date.now(),
				message: error instanceof Error ? error.message : String(error),
			}
			this.dropped += batch.length
			this.droppedQueueFull += batch.length
			this.warn('OTLP flush failed (batch dropped)', { signal: this.signal, error })
		} finally {
			this.inflight--
			if (this.inflight === 0) this.notifyIdle()
		}

		if (this.queuedCount() === 0) return
		if (!this.shouldFlushNow()) this.scheduleFlush()
	}
}

@Plugin(Otlp, { name: 'OtlpHub', type: 'service' })
export class OtlpHub extends Otlp {
	private core: OtlpHubCoreConfig = this.configs.use(OtlpHubCoreCfgSchema)
	private targets: v.InferOutput<typeof OtlpHubTargetsCfgSchema> = this.configs.use(OtlpHubTargetsCfgSchema)
	private routing: OtlpHubRoutingConfig = this.configs.use(OtlpHubRoutingCfgSchema)
	private signals: OtlpHubSignalsConfig = this.configs.use(OtlpHubSignalsCfgSchema)
	private resourceCfg: v.InferOutput<typeof OtlpHubResourceCfgSchema> = this.configs.use(OtlpHubResourceCfgSchema)
	private scopeCfg: v.InferOutput<typeof OtlpHubScopeCfgSchema> = this.configs.use(OtlpHubScopeCfgSchema)
	private batch: OtlpHubBatchConfig = this.configs.use(OtlpHubBatchCfgSchema)
	private queueCfg: OtlpHubQueueConfig = this.configs.use(OtlpHubQueueCfgSchema)

	private cfg!: {
		core: OtlpHubCoreConfig
		targets: v.InferOutput<typeof OtlpHubTargetsCfgSchema>
		routing: OtlpHubRoutingConfig
		signals: OtlpHubSignalsConfig
		resource: v.InferOutput<typeof OtlpHubResourceCfgSchema>
		scope: v.InferOutput<typeof OtlpHubScopeCfgSchema>
		batch: OtlpHubBatchConfig
		queue: OtlpHubQueueConfig
	}

	private readonly defaultTargetId = 'default'
	private warnedUnknownTargets = new Set<string>()

	private baseAttrs: OtlpAttributes = {}

	private prefix: Record<OtlpSignal, string> = { logs: '', traces: '', metrics: '' }
	private suffix: Record<OtlpSignal, string> = { logs: '', traces: '', metrics: '' }

	private destinations: Record<string, DestinationState> = {}

	override async init(_abort: AbortSignal): Promise<void> {
		this.cfg = {
			core: this.core,
			targets: this.targets,
			routing: this.routing,
			signals: this.signals,
			resource: this.resourceCfg,
			scope: this.scopeCfg,
			batch: this.batch,
			queue: this.queueCfg,
		}

		this.ctx.effects.defer(() => {
			this.clearDestinationTimers()
		})

		if (!this.cfg.core.enabled) {
			this.ctx.logger.info('OtlpHub initialized (disabled)', { enabled: false })
			this.buildExporters({ enabled: false })
			return
		}

		const resourceAttrs: OtlpAttributes = {
			'service.name': this.cfg.resource.serviceName,
			...(this.cfg.resource.serviceNamespace
				? { 'service.namespace': this.cfg.resource.serviceNamespace }
				: {}),
			...(this.cfg.resource.serviceVersion
				? { 'service.version': this.cfg.resource.serviceVersion }
				: {}),
			...(this.cfg.resource.resourceAttributes ?? {}),
		}

		const resource = { attributes: toKeyValues(resourceAttrs) }
		const scope = {
			name: this.cfg.scope.name,
			...(this.cfg.scope.version ? { version: this.cfg.scope.version } : {}),
		}

		const resourceJson = JSON.stringify(resource)
		const scopeJson = JSON.stringify(scope)

		this.prefix.logs = `{"resourceLogs":[{"resource":${resourceJson},"scopeLogs":[{"scope":${scopeJson},"logRecords":[`
		this.suffix.logs = `]}]}]}`

		this.prefix.traces = `{"resourceSpans":[{"resource":${resourceJson},"scopeSpans":[{"scope":${scopeJson},"spans":[`
		this.suffix.traces = `]}]}]}`

		this.prefix.metrics = `{"resourceMetrics":[{"resource":${resourceJson},"scopeMetrics":[{"scope":${scopeJson},"metrics":[`
		this.suffix.metrics = `]}]}]}`

		this.baseAttrs = { 'pluxel.provider.id': this.ctx.pluginInfo.id, 'pluxel.provider.name': this.ctx.pluginInfo.displayName }

		this.buildExporters({ enabled: true })

		this.ctx.logger.info('OtlpHub initialized', {
			enabled: this.cfg.core.enabled,
			endpoint: normalizeEndpoint(this.cfg.core.endpoint),
			targets: Array.isArray(this.cfg.targets) ? this.cfg.targets.map((t) => t.id).filter(Boolean) : [],
			signals: this.cfg.signals,
			flushIntervalMs: this.cfg.batch.flushIntervalMs,
		})
	}

	override async stop(_abort: AbortSignal): Promise<void> {
		try {
			await this.flush()
		} catch {
			// best-effort
		} finally {
			this.clearDestinationTimers()
		}
	}

	private clearDestinationTimers(): void {
		for (const d of Object.values(this.destinations)) {
			try {
				d.logsQ.clearTimers()
				d.tracesQ.clearTimers()
				d.metricsQ.clearTimers()
			} catch {
				// ignore
			}
		}
	}

	private buildExporters(opts: { enabled: boolean }): void {
		const enabled = !!opts.enabled
		const coreTimeoutMs = Math.max(1, Math.floor(this.cfg?.core?.timeoutMs ?? 10_000))
		const batch = this.cfg?.batch ?? { flushIntervalMs: 1000, maxBatchRecords: 256, maxBatchBytes: 256 * 1024, maxInflight: 1 }
		const queue = this.cfg?.queue ?? { maxQueuedRecords: 5000, maxQueuedBytes: 2 * 1024 * 1024, overflow: 'dropNewest' }

		const mkSend =
			(dest: { endpoint: string; headers: Record<string, string> }, signal: OtlpSignal, path: '/v1/logs' | '/v1/traces' | '/v1/metrics') =>
			async (body: string, tMs: number) => {
				if (!enabled) return
				const url = `${dest.endpoint}${path}`
			const headers: Record<string, string> = {
				'content-type': 'application/json',
				accept: 'application/json',
				'user-agent': 'pluxel-otlp/0.1',
				...dest.headers,
			}

			let controller: AbortController | undefined
			let t: any = null
			const timeout = Math.max(1, Math.floor(tMs))
			if (Number.isFinite(timeout) && timeout > 0) {
				controller = new AbortController()
				t = setTimeout(() => controller?.abort(), timeout)
			}

			try {
				const res = await fetch(url, {
					method: 'POST',
					headers,
					body,
					...(controller ? { signal: controller.signal } : {}),
				})
				if (!res.ok) {
					const text = await res.text().catch(() => '')
					throw new Error(`[otlp] http ${res.status}${text ? `: ${text}` : ''}`)
				}
			} finally {
				if (t) clearTimeout(t)
			}
		}

		const mkQueue = (dest: { endpoint: string; headers: Record<string, string>; timeoutMs: number }, signal: OtlpSignal, path: '/v1/logs' | '/v1/traces' | '/v1/metrics') =>
			new OtlpHttpJsonQueue({
				signal,
				enabled: enabled && !!this.cfg?.core?.enabled && !!this.cfg?.signals?.[signal],
				batch,
				queueCfg: queue,
				timeoutMs: dest.timeoutMs,
				buildBody: (items) => `${this.prefix[signal]}${items.map((i) => i.json).join(',')}${this.suffix[signal]}`,
				sendRequest: mkSend(dest, signal, path),
				warn: (message, meta) => this.ctx.logger.warn(message, meta),
			})

		const dests: Record<string, DestinationState> = {}
		const addDestination = (id: string, endpointRaw: string, headers: Record<string, string>, timeoutMs: number) => {
			const endpoint = normalizeEndpoint(endpointRaw)
			const dest = { endpoint, headers, timeoutMs }
			dests[id] = {
				endpoint,
				headers,
				timeoutMs,
				logsQ: mkQueue(dest, 'logs', '/v1/logs'),
				tracesQ: mkQueue(dest, 'traces', '/v1/traces'),
				metricsQ: mkQueue(dest, 'metrics', '/v1/metrics'),
			}
		}

		addDestination(this.defaultTargetId, this.cfg?.core?.endpoint ?? 'http://localhost:4318', { ...(this.cfg?.core?.headers ?? {}) }, coreTimeoutMs)

		for (const t of (Array.isArray(this.cfg?.targets) ? this.cfg.targets : []) as OtlpHubTargetConfig[]) {
			const id = String((t as any)?.id ?? '').trim()
			if (!id || id === this.defaultTargetId) continue
			addDestination(id, String((t as any)?.endpoint ?? this.cfg?.core?.endpoint ?? ''), { ...(t.headers ?? {}) }, Math.max(1, Math.floor(t.timeoutMs ?? coreTimeoutMs)))
		}

		this.destinations = dests
	}

	private callerMeta(): { attrs: OtlpAttributes; callerId: string; callerName: string } {
		const caller = this.callerOrSelf() as unknown as Context
		const callerId = String((caller as any)?.pluginInfo?.id ?? '').trim()
		const callerName = String((caller as any)?.pluginInfo?.displayName ?? '').trim()
		const callerAttrs: OtlpAttributes = {
			...(callerId ? { 'pluxel.caller.id': callerId } : {}),
			...(callerName ? { 'pluxel.caller.name': callerName } : {}),
		}
		return { attrs: { ...this.baseAttrs, ...callerAttrs }, callerId, callerName }
	}

	private resolveDestination(callerId: string, callerName: string) {
		const routing = this.cfg?.routing
		const byCallerId = routing?.byCallerId ?? {}
		const byCallerName = routing?.byCallerName ?? {}
		const defaultTargetId = String(routing?.defaultTargetId ?? '').trim()

		const mapped =
			(callerId && typeof byCallerId === 'object' ? String((byCallerId as any)[callerId] ?? '').trim() : '') ||
			(callerName && typeof byCallerName === 'object' ? String((byCallerName as any)[callerName] ?? '').trim() : '') ||
			defaultTargetId

		const targetId = mapped || this.defaultTargetId
		const dest = this.destinations[targetId]
		if (dest) return dest

		if (targetId && !this.warnedUnknownTargets.has(targetId)) {
			this.warnedUnknownTargets.add(targetId)
			this.ctx.logger.warn('[otlp] unknown routing target id (falling back to default)', { targetId, callerId, callerName })
		}
		return this.destinations[this.defaultTargetId] ?? Object.values(this.destinations)[0]
	}

	override stats(): OtlpStats {
		const empty = (): OtlpSignalStats => ({
			enabled: false,
			queued: 0,
			queuedBytes: 0,
			inflight: 0,
			sentBatches: 0,
			sentItems: 0,
			dropped: 0,
			droppedQueueFull: 0,
			droppedDisabled: 0,
		})
		const merge = (a: OtlpSignalStats, b: OtlpSignalStats): OtlpSignalStats => {
			const lastError = [a.lastError, b.lastError].filter(Boolean).sort((x, y) => (Number(y!.at) ?? 0) - (Number(x!.at) ?? 0))[0]
			return {
				enabled: a.enabled || b.enabled,
				queued: a.queued + b.queued,
				queuedBytes: a.queuedBytes + b.queuedBytes,
				inflight: a.inflight + b.inflight,
				sentBatches: a.sentBatches + b.sentBatches,
				sentItems: a.sentItems + b.sentItems,
				dropped: a.dropped + b.dropped,
				droppedQueueFull: a.droppedQueueFull + b.droppedQueueFull,
				droppedDisabled: a.droppedDisabled + b.droppedDisabled,
				...(lastError ? { lastError } : {}),
			}
		}

		let logs = empty()
		let traces = empty()
		let metrics = empty()
		for (const d of Object.values(this.destinations)) {
			logs = merge(logs, d.logsQ.stats())
			traces = merge(traces, d.tracesQ.stats())
			metrics = merge(metrics, d.metricsQ.stats())
		}

		const signals = { logs, traces, metrics }

		const list = Object.values(signals)
		const lastError = list
			.map((s) => s.lastError)
			.filter(Boolean)
			.sort((a, b) => (b!.at ?? 0) - (a!.at ?? 0))[0]

		return {
			enabled: !!this.cfg?.core?.enabled,
			queued: list.reduce((n, s) => n + (s.queued ?? 0), 0),
			queuedBytes: list.reduce((n, s) => n + (s.queuedBytes ?? 0), 0),
			inflight: list.reduce((n, s) => n + (s.inflight ?? 0), 0),
			sent: list.reduce((n, s) => n + (s.sentBatches ?? 0), 0),
			sentRecords: list.reduce((n, s) => n + (s.sentItems ?? 0), 0),
			dropped: list.reduce((n, s) => n + (s.dropped ?? 0), 0),
			droppedQueueFull: list.reduce((n, s) => n + (s.droppedQueueFull ?? 0), 0),
			droppedDisabled: list.reduce((n, s) => n + (s.droppedDisabled ?? 0), 0),
			...(lastError ? { lastError } : {}),
			signals,
		}
	}

	override async log(input: OtlpLogRecordInput | readonly OtlpLogRecordInput[]): Promise<void> {
		const caller = this.callerMeta()
		const dest = this.resolveDestination(caller.callerId, caller.callerName)
		if (!dest) return
		const q = dest.logsQ
		const baseAttrs = caller.attrs
		const list = Array.isArray(input) ? input : [input]
		for (const item of list) await q.enqueue(logRecordToItem(item, baseAttrs))
	}

	override logSync(input: OtlpLogRecordInput | readonly OtlpLogRecordInput[]): void {
		const caller = this.callerMeta()
		const dest = this.resolveDestination(caller.callerId, caller.callerName)
		if (!dest) return
		const q = dest.logsQ
		const baseAttrs = caller.attrs
		const list = Array.isArray(input) ? input : [input]
		for (const item of list) q.tryEnqueue(logRecordToItem(item, baseAttrs))
	}

	override async trace(input: OtlpSpanInput | readonly OtlpSpanInput[]): Promise<void> {
		const caller = this.callerMeta()
		const dest = this.resolveDestination(caller.callerId, caller.callerName)
		if (!dest) return
		const q = dest.tracesQ
		const baseAttrs = caller.attrs
		const list = Array.isArray(input) ? input : [input]
		for (const item of list) await q.enqueue(spanToItem(item, baseAttrs))
	}

	override traceSync(input: OtlpSpanInput | readonly OtlpSpanInput[]): void {
		const caller = this.callerMeta()
		const dest = this.resolveDestination(caller.callerId, caller.callerName)
		if (!dest) return
		const q = dest.tracesQ
		const baseAttrs = caller.attrs
		const list = Array.isArray(input) ? input : [input]
		for (const item of list) q.tryEnqueue(spanToItem(item, baseAttrs))
	}

	override span(name: string, opts?: Omit<OtlpSpanInput, 'name'>): OtlpSpanHandle {
		const traceId = (opts?.traceId ?? '').trim() || randomHex(16)
		const spanId = (opts?.spanId ?? '').trim() || randomHex(8)
		const parentSpanId = (opts?.parentSpanId ?? '').trim()
		const kind = opts?.kind
		const startTsMs = typeof opts?.startTsMs === 'number' ? opts.startTsMs : Date.now()

		let ended = false
		let mergedAttributes: OtlpAttributes = { ...(opts?.attributes ?? {}) }
		const events: Array<{ name: string; attributes?: OtlpAttributes; tsMs?: number }> = []

		const event = (evtName: string, attributes?: OtlpAttributes, tsMs?: number) => {
			if (ended) return
			events.push({ name: evtName, attributes, tsMs })
		}

		const setAttributes = (attributes: OtlpAttributes) => {
			if (ended) return
			mergedAttributes = { ...mergedAttributes, ...(attributes ?? {}) }
		}

		const end = async (endOpts?: { status?: OtlpSpanStatus; error?: unknown; attributes?: OtlpAttributes; endTsMs?: number }) => {
			if (ended) return
			ended = true

			const endTsMs = typeof endOpts?.endTsMs === 'number' ? endOpts.endTsMs : Date.now()
			const status: OtlpSpanStatus = endOpts?.status ?? (endOpts?.error ? 'error' : (opts?.status ?? 'unset'))
			const error = endOpts?.error ?? opts?.error
			const durationMs = Math.max(0, endTsMs - startTsMs)

			const attrs: OtlpAttributes = {
				...mergedAttributes,
				...(endOpts?.attributes ?? {}),
				durationMs,
			}

			const tracesEnabled = !!this.cfg?.core?.enabled && !!this.cfg?.signals?.traces
			if (tracesEnabled) {
				await this.trace({
					name,
					traceId,
					spanId,
					...(parentSpanId ? { parentSpanId } : {}),
					...(kind ? { kind } : {}),
					attributes: attrs,
					events,
					startTsMs,
					endTsMs,
					...(status ? { status } : {}),
					...(error ? { error } : {}),
				})
				return
			}

			const ok = status !== 'error' && !error
			await this.log({
				level: ok ? 'info' : 'error',
				body: name,
				attributes: {
					'otel.kind': 'span',
					ok,
					traceId,
					spanId,
					...(parentSpanId ? { parentSpanId } : {}),
					...(kind ? { kind } : {}),
					...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
					...attrs,
				},
				tsMs: endTsMs,
			})
		}

		return { traceId, spanId, event, setAttributes, end }
	}

	override async metric(input: OtlpMetricPointInput | readonly OtlpMetricPointInput[]): Promise<void> {
		const caller = this.callerMeta()
		const dest = this.resolveDestination(caller.callerId, caller.callerName)
		if (!dest) return
		const q = dest.metricsQ
		const baseAttrs = caller.attrs
		const list = Array.isArray(input) ? input : [input]
		for (const item of list) await q.enqueue(metricPointToItem(item, baseAttrs))
	}

	override metricSync(input: OtlpMetricPointInput | readonly OtlpMetricPointInput[]): void {
		const caller = this.callerMeta()
		const dest = this.resolveDestination(caller.callerId, caller.callerName)
		if (!dest) return
		const q = dest.metricsQ
		const baseAttrs = caller.attrs
		const list = Array.isArray(input) ? input : [input]
		for (const item of list) q.tryEnqueue(metricPointToItem(item, baseAttrs))
	}

	override async flush(): Promise<void> {
		for (const d of Object.values(this.destinations)) {
			await d.logsQ.flush()
			await d.tracesQ.flush()
			await d.metricsQ.flush()
		}
	}
}
