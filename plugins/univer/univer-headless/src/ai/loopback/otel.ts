import type { Counter, Histogram, Meter, Span, Tracer } from '@opentelemetry/api'
import { SpanStatusCode, context as otelContext, trace } from '@opentelemetry/api'

export type UniverAxOtel = Readonly<{
	tracer?: Tracer
	meter?: Meter
	attributes?: Record<string, string | number | boolean>
}>

export type UniverAxOtelInstruments = Readonly<{
	toolCalls?: Counter
	toolErrors?: Counter
	toolLatencyMs?: Histogram
	attempts?: Counter
}>

export function createUniverAxOtelInstruments(meter?: Meter): UniverAxOtelInstruments {
	if (!meter) return {}
	return {
		toolCalls: meter.createCounter('univer.tool.calls', { description: 'Total Univer tool calls' }),
		toolErrors: meter.createCounter('univer.tool.errors', { description: 'Total Univer tool errors' }),
		toolLatencyMs: meter.createHistogram('univer.tool.latency_ms', {
			description: 'Univer tool call latency (ms)',
			unit: 'ms',
			advice: { explicitBucketBoundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000] },
		}),
		attempts: meter.createCounter('univer.loopback.attempts', { description: 'Total loopback attempts (AxFlow feedback iterations)' }),
	}
}

export function getActiveSpan(): Span | undefined {
	return trace.getSpan(otelContext.active()) ?? undefined
}

export function spanOk(span: Span, message?: string) {
	span.setStatus({ code: SpanStatusCode.OK, ...(message ? { message } : {}) })
}

export function spanError(span: Span, error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	try {
		if (error instanceof Error) span.recordException(error)
		else span.recordException(message)
	} catch {
		// ignore
	}
	span.setStatus({ code: SpanStatusCode.ERROR, message })
}

