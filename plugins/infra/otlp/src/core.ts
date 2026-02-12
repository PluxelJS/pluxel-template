import type { Context } from '@pluxel/hmr'
import { BasePlugin } from '@pluxel/hmr'

export type OtlpLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export type OtlpAttributes = Record<string, unknown>

export type OtlpLogRecordInput = {
	level?: OtlpLogLevel
	body: unknown
	attributes?: OtlpAttributes
	tsMs?: number
}

export type OtlpSignal = 'logs' | 'traces' | 'metrics'

export type OtlpSignalStats = {
	enabled: boolean
	queued: number
	queuedBytes: number
	inflight: number
	sentBatches: number
	sentItems: number
	dropped: number
	droppedQueueFull: number
	droppedDisabled: number
	lastError?: { at: number; message: string }
}

export type OtlpStats = {
	enabled: boolean
	/**
	 * Aggregated totals across all enabled signals.
	 * Kept for convenience/back-compat with earlier "logs-only" stats.
	 */
	queued: number
	queuedBytes: number
	inflight: number
	sent: number
	sentRecords: number
	dropped: number
	droppedQueueFull: number
	droppedDisabled: number
	lastError?: { at: number; message: string }
	signals: Record<OtlpSignal, OtlpSignalStats>
}

export type OtlpLogger = {
	trace: (body: unknown, attributes?: OtlpAttributes) => Promise<void>
	debug: (body: unknown, attributes?: OtlpAttributes) => Promise<void>
	info: (body: unknown, attributes?: OtlpAttributes) => Promise<void>
	warn: (body: unknown, attributes?: OtlpAttributes) => Promise<void>
	error: (body: unknown, attributes?: OtlpAttributes) => Promise<void>
	fatal: (body: unknown, attributes?: OtlpAttributes) => Promise<void>
	child: (attributes: OtlpAttributes) => OtlpLogger
}

export type OtlpSpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer'
export type OtlpSpanStatus = 'unset' | 'ok' | 'error'

export type OtlpSpanEventInput = {
	name: string
	attributes?: OtlpAttributes
	tsMs?: number
}

export type OtlpSpanInput = {
	name: string
	traceId?: string
	spanId?: string
	parentSpanId?: string
	kind?: OtlpSpanKind
	status?: OtlpSpanStatus
	error?: unknown
	attributes?: OtlpAttributes
	events?: readonly OtlpSpanEventInput[]
	startTsMs?: number
	endTsMs?: number
}

export type OtlpSpanHandle = {
	traceId: string
	spanId: string
	event: (name: string, attributes?: OtlpAttributes, tsMs?: number) => void
	setAttributes: (attributes: OtlpAttributes) => void
	end: (opts?: {
		status?: OtlpSpanStatus
		error?: unknown
		attributes?: OtlpAttributes
		endTsMs?: number
	}) => Promise<void>
}

export type OtlpMetricTemporality = 'delta' | 'cumulative'

export type OtlpMetricPointBase = {
	name: string
	description?: string
	unit?: string
	attributes?: OtlpAttributes
	tsMs?: number
}

export type OtlpCounterPoint = OtlpMetricPointBase & {
	type: 'counter'
	value: number
	temporality?: OtlpMetricTemporality
	monotonic?: boolean
}

export type OtlpGaugePoint = OtlpMetricPointBase & {
	type: 'gauge'
	value: number
}

export type OtlpHistogramPoint = OtlpMetricPointBase & {
	type: 'histogram'
	value: number
	bounds?: readonly number[]
	temporality?: OtlpMetricTemporality
}

export type OtlpMetricPointInput = OtlpCounterPoint | OtlpGaugePoint | OtlpHistogramPoint

export type OtlpCounter = {
	add: (delta: number, attributes?: OtlpAttributes, tsMs?: number) => Promise<void>
	child: (attributes: OtlpAttributes) => OtlpCounter
}

export type OtlpGauge = {
	set: (value: number, attributes?: OtlpAttributes, tsMs?: number) => Promise<void>
	child: (attributes: OtlpAttributes) => OtlpGauge
}

export type OtlpHistogram = {
	record: (value: number, attributes?: OtlpAttributes, tsMs?: number) => Promise<void>
	child: (attributes: OtlpAttributes) => OtlpHistogram
}

export abstract class Otlp extends BasePlugin {
	protected callerOrSelf(): Context {
		return (this.ctx.caller as any) ?? (this.ctx as any)
	}

	abstract log(input: OtlpLogRecordInput | readonly OtlpLogRecordInput[]): Promise<void>
	/**
	 * Best-effort, non-blocking write path intended for OpenTelemetry API bridges
	 * (where instrument methods are synchronous). Providers may override to avoid
	 * creating backpressure-related Promises.
	 */
	logSync(input: OtlpLogRecordInput | readonly OtlpLogRecordInput[]): void {
		void this.log(input)
	}

	abstract trace(input: OtlpSpanInput | readonly OtlpSpanInput[]): Promise<void>
	traceSync(input: OtlpSpanInput | readonly OtlpSpanInput[]): void {
		void this.trace(input)
	}

	abstract span(name: string, opts?: Omit<OtlpSpanInput, 'name'>): OtlpSpanHandle

	abstract metric(input: OtlpMetricPointInput | readonly OtlpMetricPointInput[]): Promise<void>
	metricSync(input: OtlpMetricPointInput | readonly OtlpMetricPointInput[]): void {
		void this.metric(input)
	}

	abstract flush(): Promise<void>

	abstract stats(): OtlpStats

	logger(opts?: { attributes?: OtlpAttributes }): OtlpLogger {
		const base = opts?.attributes ?? {}
		const child = (more: OtlpAttributes): OtlpLogger => this.logger({ attributes: { ...base, ...more } })
		const mk = (level: OtlpLogLevel) => async (body: unknown, attributes?: OtlpAttributes) => {
			await this.log({ level, body, attributes: { ...base, ...(attributes ?? {}) } })
		}
		return {
			trace: mk('trace'),
			debug: mk('debug'),
			info: mk('info'),
			warn: mk('warn'),
			error: mk('error'),
			fatal: mk('fatal'),
			child,
		}
	}

	counter(name: string, opts?: Omit<OtlpCounterPoint, 'type' | 'name' | 'value'>): OtlpCounter {
		const base = opts?.attributes ?? {}
		const child = (more: OtlpAttributes): OtlpCounter => this.counter(name, { ...opts, attributes: { ...base, ...more } })
		return {
			add: async (delta: number, attributes?: OtlpAttributes, tsMs?: number) => {
				await this.metric({
					type: 'counter',
					name,
					value: delta,
					description: opts?.description,
					unit: opts?.unit,
					temporality: opts?.temporality,
					monotonic: opts?.monotonic,
					attributes: { ...base, ...(attributes ?? {}) },
					...(typeof tsMs === 'number' ? { tsMs } : {}),
				})
			},
			child,
		}
	}

	gauge(name: string, opts?: Omit<OtlpGaugePoint, 'type' | 'name' | 'value'>): OtlpGauge {
		const base = opts?.attributes ?? {}
		const child = (more: OtlpAttributes): OtlpGauge => this.gauge(name, { ...opts, attributes: { ...base, ...more } })
		return {
			set: async (value: number, attributes?: OtlpAttributes, tsMs?: number) => {
				await this.metric({
					type: 'gauge',
					name,
					value,
					description: opts?.description,
					unit: opts?.unit,
					attributes: { ...base, ...(attributes ?? {}) },
					...(typeof tsMs === 'number' ? { tsMs } : {}),
				})
			},
			child,
		}
	}

	histogram(name: string, opts?: Omit<OtlpHistogramPoint, 'type' | 'name' | 'value'>): OtlpHistogram {
		const base = opts?.attributes ?? {}
		const child = (more: OtlpAttributes): OtlpHistogram => this.histogram(name, { ...opts, attributes: { ...base, ...more } })
		return {
			record: async (value: number, attributes?: OtlpAttributes, tsMs?: number) => {
				await this.metric({
					type: 'histogram',
					name,
					value,
					description: opts?.description,
					unit: opts?.unit,
					bounds: opts?.bounds,
					temporality: opts?.temporality,
					attributes: { ...base, ...(attributes ?? {}) },
					...(typeof tsMs === 'number' ? { tsMs } : {}),
				})
			},
			child,
		}
	}
}
