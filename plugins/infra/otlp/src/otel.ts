import { context as otelContext, trace } from '@opentelemetry/api'
import type { Exception, TimeInput } from '@opentelemetry/api'
import type { Context as OtelContext } from '@opentelemetry/api'
import type {
	Counter,
	Gauge,
	Histogram,
	Meter,
	MetricAttributes,
	MetricOptions,
	ObservableCounter,
	ObservableGauge,
	ObservableUpDownCounter,
	Tracer,
	UpDownCounter,
} from '@opentelemetry/api'
import type { Link, Span, SpanAttributes, SpanContext, SpanKind, SpanOptions, SpanStatus } from '@opentelemetry/api'
import { SpanStatusCode, TraceFlags } from '@opentelemetry/api'

import type { Otlp, OtlpAttributes, OtlpMetricPointInput, OtlpSpanInput, OtlpSpanKind, OtlpSpanStatus } from './core.js'
import { randomHex } from './id.js'

type MaybeSyncOtlp = Otlp & {
	traceSync?: (input: OtlpSpanInput | readonly OtlpSpanInput[]) => void
	metricSync?: (input: OtlpMetricPointInput | readonly OtlpMetricPointInput[]) => void
	logSync?: (input: any) => void
}

function timeInputToUnixMs(t?: TimeInput): number | undefined {
	if (t === undefined) return undefined
	if (Array.isArray(t)) return t[0] * 1000 + t[1] / 1e6
	if (t instanceof Date) return t.getTime()
	if (typeof t === 'number') {
		// TimeInput may be epoch-ms or performance.now(). If it looks like epoch-ms, keep it.
		if (t > 1_000_000_000_000) return t
		return Date.now()
	}
	return undefined
}

function otelSpanKindToOtlp(kind: SpanKind | undefined): OtlpSpanKind {
	switch (kind) {
		case 1:
			return 'server'
		case 2:
			return 'client'
		case 3:
			return 'producer'
		case 4:
			return 'consumer'
		case 0:
		default:
			return 'internal'
	}
}

function otelStatusToOtlp(status: SpanStatus | undefined, error?: unknown): { status?: OtlpSpanStatus; error?: unknown } {
	const code = status?.code ?? SpanStatusCode.UNSET
	if (code === SpanStatusCode.ERROR) return { status: 'error', ...(error ? { error } : {}) }
	if (code === SpanStatusCode.OK) return { status: 'ok' }
	if (error) return { status: 'error', error }
	return { status: 'unset' }
}

function sanitizeAttrs(attrs?: SpanAttributes | MetricAttributes): OtlpAttributes | undefined {
	if (!attrs) return undefined
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(attrs)) {
		if (!k) continue
		out[k] = v as unknown
	}
	return out
}

type OtlpOtelTracerOptions = {
	/** Useful when one OtlpHub serves multiple codepaths. */
	tracerName?: string
	/** Extra span attributes applied to every span. */
	attributes?: OtlpAttributes
}

class OtlpOtelSpan implements Span {
	private ended = false
	private name: string
	private readonly startTsMs: number
	private readonly spanCtx: SpanContext
	private readonly otlp: MaybeSyncOtlp
	private readonly parentSpanId?: string
	private readonly kind?: OtlpSpanKind
	private readonly baseAttrs: OtlpAttributes

	private attrs: OtlpAttributes = {}
	private status: SpanStatus | undefined
	private error: unknown
	private events: Array<{ name: string; attributes?: OtlpAttributes; tsMs?: number }> = []

	constructor(opts: {
		otlp: MaybeSyncOtlp
		name: string
		spanContext: SpanContext
		parentSpanId?: string
		kind?: OtlpSpanKind
		startTsMs: number
		baseAttrs: OtlpAttributes
		initialAttrs?: OtlpAttributes
	}) {
		this.otlp = opts.otlp
		this.name = opts.name
		this.spanCtx = opts.spanContext
		this.parentSpanId = opts.parentSpanId
		this.kind = opts.kind
		this.startTsMs = opts.startTsMs
		this.baseAttrs = opts.baseAttrs
		this.attrs = { ...(opts.initialAttrs ?? {}) }
	}

	spanContext(): SpanContext {
		return this.spanCtx
	}

	setAttribute(key: string, value: any): this {
		if (this.ended) return this
		if (!key) return this
		this.attrs[key] = value
		return this
	}

	setAttributes(attributes: SpanAttributes): this {
		if (this.ended) return this
		for (const [k, v] of Object.entries(attributes ?? {})) this.setAttribute(k, v as any)
		return this
	}

	addEvent(name: string, attributesOrStartTime?: SpanAttributes | TimeInput, startTime?: TimeInput): this {
		if (this.ended) return this
		const attrs =
			attributesOrStartTime && typeof attributesOrStartTime === 'object' && !Array.isArray(attributesOrStartTime) && !(attributesOrStartTime instanceof Date)
				? sanitizeAttrs(attributesOrStartTime as SpanAttributes)
				: undefined
		const tsMs = timeInputToUnixMs((startTime ?? (attrs ? undefined : (attributesOrStartTime as TimeInput))) as any)
		this.events.push({ name, ...(attrs ? { attributes: attrs } : {}), ...(typeof tsMs === 'number' ? { tsMs } : {}) })
		return this
	}

	addLink(_link: Link): this {
		// OTLP bridge (minimal): ignore links for now.
		return this
	}

	addLinks(_links: Link[]): this {
		return this
	}

	setStatus(status: SpanStatus): this {
		if (this.ended) return this
		this.status = status
		if (status?.code === SpanStatusCode.ERROR && status.message) this.error = new Error(status.message)
		return this
	}

	updateName(name: string): this {
		if (this.ended) return this
		this.name = name
		return this
	}

	end(endTime?: TimeInput): void {
		if (this.ended) return
		this.ended = true

		const endTsMs = timeInputToUnixMs(endTime) ?? Date.now()

		const mergedAttrs: OtlpAttributes = { ...this.baseAttrs, ...this.attrs }
		const otlpStatus = otelStatusToOtlp(this.status, this.error)

		const span: OtlpSpanInput = {
			name: this.name,
			traceId: this.spanCtx.traceId,
			spanId: this.spanCtx.spanId,
			...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
			...(this.kind ? { kind: this.kind } : {}),
			attributes: mergedAttrs,
			events: this.events,
			startTsMs: this.startTsMs,
			endTsMs,
			...(otlpStatus.status ? { status: otlpStatus.status } : {}),
			...(otlpStatus.error ? { error: otlpStatus.error } : {}),
		}

		if (typeof this.otlp.traceSync === 'function') this.otlp.traceSync(span)
		else void this.otlp.trace(span)
	}

	isRecording(): boolean {
		return !this.ended
	}

	recordException(exception: Exception, time?: TimeInput): void {
		if (this.ended) return
		const err = typeof exception === 'string' ? new Error(exception) : exception
		this.error = err
		const attrs: OtlpAttributes = {
			'exception.type': err instanceof Error ? err.name : 'Error',
			'exception.message': err instanceof Error ? err.message : String(err),
			...(err instanceof Error && err.stack ? { 'exception.stacktrace': err.stack } : {}),
		}
		const tsMs = timeInputToUnixMs(time) ?? Date.now()
		this.events.push({ name: 'exception', attributes: attrs, tsMs })
	}
}

class OtlpOtelTracer implements Tracer {
	private readonly otlp: MaybeSyncOtlp
	private readonly tracerName?: string
	private readonly baseAttrs: OtlpAttributes

	constructor(otlp: MaybeSyncOtlp, opts?: OtlpOtelTracerOptions) {
		this.otlp = otlp
		this.tracerName = opts?.tracerName
		this.baseAttrs = { ...(opts?.attributes ?? {}), ...(opts?.tracerName ? { 'otel.tracer.name': opts.tracerName } : {}) }
	}

	startSpan(name: string, options?: SpanOptions, ctx?: OtelContext): Span {
		const parentCtx = ctx ?? otelContext.active()
		const parent = trace.getSpanContext(parentCtx) ?? trace.getSpan(parentCtx)?.spanContext()

		const traceId = parent?.traceId && parent.traceId.length === 32 ? parent.traceId : randomHex(16)
		const spanId = randomHex(8)
		const parentSpanId = parent?.spanId

		const kind = otelSpanKindToOtlp(options?.kind as any)
		const startTsMs = timeInputToUnixMs(options?.startTime as any) ?? Date.now()

		const flags = parent?.traceFlags ?? TraceFlags.SAMPLED
		const spanContext: SpanContext = {
			traceId,
			spanId,
			traceFlags: flags,
			...(parent?.traceState ? { traceState: parent.traceState } : {}),
		}

		const initialAttrs: OtlpAttributes = {
			...(options?.attributes ? sanitizeAttrs(options.attributes) : {}),
		}

		return new OtlpOtelSpan({
			otlp: this.otlp,
			name,
			spanContext,
			parentSpanId,
			kind,
			startTsMs,
			baseAttrs: this.baseAttrs,
			initialAttrs,
		})
	}

	startActiveSpan<F extends (span: Span) => unknown>(name: string, optionsOrFn: any, contextOrFn?: any, fn?: any): ReturnType<F> {
		let options: SpanOptions | undefined
		let parentCtx: OtelContext | undefined
		let callback: ((span: Span) => unknown) | undefined

		if (typeof optionsOrFn === 'function') {
			callback = optionsOrFn
		} else if (typeof contextOrFn === 'function') {
			options = optionsOrFn
			callback = contextOrFn
		} else {
			options = optionsOrFn
			parentCtx = contextOrFn
			callback = fn
		}

		if (typeof callback !== 'function') throw new Error('[otlp] startActiveSpan requires a callback')

		const span = this.startSpan(name, options, parentCtx)
		const ctxWithSpan = trace.setSpan(parentCtx ?? otelContext.active(), span)
		return otelContext.with(ctxWithSpan, () => callback!(span)) as ReturnType<F>
	}
}

type OtlpOtelMeterOptions = {
	meterName?: string
	attributes?: OtlpAttributes
}

function metricBaseAttrs(opts?: OtlpOtelMeterOptions): OtlpAttributes {
	return { ...(opts?.attributes ?? {}), ...(opts?.meterName ? { 'otel.meter.name': opts.meterName } : {}) }
}

class OtlpOtelMeter implements Meter {
	private readonly otlp: MaybeSyncOtlp
	private readonly base: OtlpAttributes

	constructor(otlp: MaybeSyncOtlp, opts?: OtlpOtelMeterOptions) {
		this.otlp = otlp
		this.base = metricBaseAttrs(opts)
	}

	createGauge<AttributesTypes extends MetricAttributes = MetricAttributes>(name: string, options?: MetricOptions): Gauge<AttributesTypes> {
		return {
			record: (value: number, attributes?: AttributesTypes) => {
				const point: OtlpMetricPointInput = {
					type: 'gauge',
					name,
					...(options?.description ? { description: options.description } : {}),
					...(options?.unit ? { unit: options.unit } : {}),
					value,
					attributes: { ...this.base, ...(attributes ? sanitizeAttrs(attributes) : {}) },
				}
				if (typeof this.otlp.metricSync === 'function') this.otlp.metricSync(point)
				else void this.otlp.metric(point)
			},
		}
	}

	createHistogram<AttributesTypes extends MetricAttributes = MetricAttributes>(name: string, options?: MetricOptions): Histogram<AttributesTypes> {
		const bounds = options?.advice?.explicitBucketBoundaries?.slice()
		return {
			record: (value: number, attributes?: AttributesTypes) => {
				const point: OtlpMetricPointInput = {
					type: 'histogram',
					name,
					...(options?.description ? { description: options.description } : {}),
					...(options?.unit ? { unit: options.unit } : {}),
					value,
					...(bounds?.length ? { bounds } : {}),
					attributes: { ...this.base, ...(attributes ? sanitizeAttrs(attributes) : {}) },
				}
				if (typeof this.otlp.metricSync === 'function') this.otlp.metricSync(point)
				else void this.otlp.metric(point)
			},
		}
	}

	createCounter<AttributesTypes extends MetricAttributes = MetricAttributes>(name: string, options?: MetricOptions): Counter<AttributesTypes> {
		return {
			add: (value: number, attributes?: AttributesTypes) => {
				const point: OtlpMetricPointInput = {
					type: 'counter',
					name,
					...(options?.description ? { description: options.description } : {}),
					...(options?.unit ? { unit: options.unit } : {}),
					value,
					temporality: 'delta',
					monotonic: true,
					attributes: { ...this.base, ...(attributes ? sanitizeAttrs(attributes) : {}) },
				}
				if (typeof this.otlp.metricSync === 'function') this.otlp.metricSync(point)
				else void this.otlp.metric(point)
			},
		}
	}

	createUpDownCounter<AttributesTypes extends MetricAttributes = MetricAttributes>(
		name: string,
		options?: MetricOptions,
	): UpDownCounter<AttributesTypes> {
		return {
			add: (value: number, attributes?: AttributesTypes) => {
				const point: OtlpMetricPointInput = {
					type: 'counter',
					name,
					...(options?.description ? { description: options.description } : {}),
					...(options?.unit ? { unit: options.unit } : {}),
					value,
					temporality: 'delta',
					monotonic: false,
					attributes: { ...this.base, ...(attributes ? sanitizeAttrs(attributes) : {}) },
				}
				if (typeof this.otlp.metricSync === 'function') this.otlp.metricSync(point)
				else void this.otlp.metric(point)
			},
		}
	}

	createObservableGauge<AttributesTypes extends MetricAttributes = MetricAttributes>(
		_name: string,
		_options?: MetricOptions,
	): ObservableGauge<AttributesTypes> {
		return { addCallback: () => {}, removeCallback: () => {} }
	}
	createObservableCounter<AttributesTypes extends MetricAttributes = MetricAttributes>(
		_name: string,
		_options?: MetricOptions,
	): ObservableCounter<AttributesTypes> {
		return { addCallback: () => {}, removeCallback: () => {} }
	}
	createObservableUpDownCounter<AttributesTypes extends MetricAttributes = MetricAttributes>(
		_name: string,
		_options?: MetricOptions,
	): ObservableUpDownCounter<AttributesTypes> {
		return { addCallback: () => {}, removeCallback: () => {} }
	}
	addBatchObservableCallback(..._args: any[]): void {}
	removeBatchObservableCallback(..._args: any[]): void {}
}

export function createOtlpOtelTracer(otlp: Otlp, opts?: OtlpOtelTracerOptions): Tracer {
	return new OtlpOtelTracer(otlp as MaybeSyncOtlp, opts)
}

export function createOtlpOtelMeter(otlp: Otlp, opts?: OtlpOtelMeterOptions): Meter {
	return new OtlpOtelMeter(otlp as MaybeSyncOtlp, opts)
}
