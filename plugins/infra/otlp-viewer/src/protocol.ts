import type { OtlpSignal } from 'pluxel-plugin-otlp'

export type OtlpViewerFilterOp = 'eq' | 'neq' | 'contains' | 'like' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte'

/**
 * Structured filters compiled to SQL server-side (no raw SQL in filters).
 *
 * Supported fields:
 * - Column-like: callerId/traceId/spanId/status/kind/name/type/level/...
 * - Attributes: `attr.<key>` (e.g. `attr.service.name`, `attr.http.method`)
 */
export type OtlpViewerFieldFilter = {
	field: string
	op: OtlpViewerFilterOp
	value?: string
}

export type OtlpViewerCommonQueryOptions = {
	q?: string
	callerId?: string
	fromTsMs?: number
	toTsMs?: number
	filters?: readonly OtlpViewerFieldFilter[]
}

export type OtlpViewerListOptions = OtlpViewerCommonQueryOptions & {
	limit?: number
	offset?: number
	level?: string
	status?: string
	name?: string
	metricType?: string
}

export type OtlpViewerListResult = Promise<{ total: number; rows: Record<string, unknown>[] }>

export type OtlpViewerFacetLimits = {
	scanRows?: number
	limitKeys?: number
	limitValues?: number
}

export type OtlpViewerSignal = OtlpSignal

