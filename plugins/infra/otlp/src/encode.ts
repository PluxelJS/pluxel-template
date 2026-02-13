import type {
	OtlpAttributes,
	OtlpLogLevel,
	OtlpLogRecordInput,
	OtlpMetricPointInput,
	OtlpSpanInput,
	OtlpSpanKind,
	OtlpSpanStatus,
} from './core.js'
import { randomHex } from './id.js'

export type OtlpHttpJsonItem = { json: string; bytes: number }

const ENCODER = new TextEncoder()

export function toUnixNano(tsMs: number): string {
	return (BigInt(Math.floor(tsMs)) * 1_000_000n).toString()
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

export function toKeyValues(attrs: OtlpAttributes | undefined): Array<{ key: string; value: any }> {
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

export function logRecordToItem(record: OtlpLogRecordInput, baseAttrs: OtlpAttributes): OtlpHttpJsonItem {
	const tsMs = typeof record.tsMs === 'number' ? record.tsMs : Date.now()
	const level: OtlpLogLevel = record.level ?? 'info'
	const traceId = String(record.traceId ?? '').trim()
	const spanId = String(record.spanId ?? '').trim()

	const attributes = toKeyValues({ ...baseAttrs, ...(record.attributes ?? {}) })
	const payload: any = {
		timeUnixNano: toUnixNano(tsMs),
		observedTimeUnixNano: toUnixNano(Date.now()),
		severityNumber: severityNumber(level),
		severityText: level.toUpperCase(),
		body: toAnyValue(record.body),
		...(traceId ? { traceId } : {}),
		...(spanId ? { spanId } : {}),
		...(attributes.length ? { attributes } : {}),
	}

	const json = JSON.stringify(payload)
	return { json, bytes: itemBytes(json) }
}

export function spanToItem(span: OtlpSpanInput, baseAttrs: OtlpAttributes): OtlpHttpJsonItem {
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

export function metricPointToItem(point: OtlpMetricPointInput, baseAttrs: OtlpAttributes): OtlpHttpJsonItem {
	const tsMs = typeof point.tsMs === 'number' ? point.tsMs : Date.now()
	const attrs = toKeyValues({ ...baseAttrs, ...(point.attributes ?? {}) })
	const timeUnixNano = toUnixNano(tsMs)
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

		const value = Number.isFinite(point.value) ? point.value : 0
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
						sum: value,
						bucketCounts,
						explicitBounds: bounds,
						min: value,
						max: value,
					},
				],
			},
		}
	}

	const json = JSON.stringify(metric)
	return { json, bytes: itemBytes(json) }
}
