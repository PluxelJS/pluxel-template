import { RpcTarget } from '@pluxel/hmr/capnweb'
import type { OtlpSignal } from 'pluxel-plugin-otlp'
import type { OtlpViewer } from './index'
import type { OtlpViewerQueryResult, OtlpViewerStoreStats, OtlpViewerTraceDetail, OtlpViewerTraceSummaryRow } from './store'

export type OtlpViewerListOptions = {
	q?: string
	callerId?: string
	fromTsMs?: number
	toTsMs?: number
	limit?: number
	offset?: number
	level?: string
	status?: string
	name?: string
	metricType?: string
	filters?: OtlpViewerFieldFilter[]
}

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

export class OtlpViewerRpc extends RpcTarget {
	constructor(private readonly viewer: OtlpViewer) {
		super()
	}

	storeStats(): OtlpViewerStoreStats {
		const store = this.viewer.getStoreOptional()
		if (!store) {
			return { enabled: false, dbPath: ':memory:', pending: { logs: 0, spans: 0, metrics: 0 }, dropped: { logs: 0, spans: 0, metrics: 0 } }
		}
		return store.stats()
	}

	list(signal: OtlpSignal, opts: OtlpViewerListOptions): Promise<{ total: number; rows: Record<string, unknown>[] }> {
		const store = this.viewer.getStoreOptional()
		if (!store) return Promise.resolve({ total: 0, rows: [] })
		return store.list(signal, opts)
	}

	listTraces(opts: OtlpViewerListOptions): Promise<{ total: number; rows: OtlpViewerTraceSummaryRow[] }> {
		const store = this.viewer.getStoreOptional()
		if (!store) return Promise.resolve({ total: 0, rows: [] })
		return store.listTraces(opts)
	}

	getTrace(traceId: string): Promise<OtlpViewerTraceDetail> {
		const store = this.viewer.getStoreOptional()
		if (!store) return Promise.resolve({ traceId: '', startTsMs: 0, endTsMs: 0, durationMs: 0, spans: 0, errors: 0, rows: [] })
		return store.getTrace(traceId)
	}

	facetKeys(signal: OtlpSignal, opts: OtlpViewerListOptions, limits?: { scanRows?: number; limitKeys?: number }): Promise<{ keys: Array<{ key: string; n: number }> }> {
		const store = this.viewer.getStoreOptional()
		if (!store) return Promise.resolve({ keys: [] })
		return store.facetKeys(signal, opts as any, limits)
	}

	facetValues(
		signal: OtlpSignal,
		key: string,
		opts: OtlpViewerListOptions,
		limits?: { scanRows?: number; limitValues?: number },
	): Promise<{ key: string; values: Array<{ value: string; type: string; n: number }> }> {
		const store = this.viewer.getStoreOptional()
		if (!store) return Promise.resolve({ key: String(key ?? ''), values: [] })
		return store.facetValues(signal, key, opts as any, limits)
	}

	query(sql: string, params?: unknown): Promise<OtlpViewerQueryResult> {
		const store = this.viewer.getStoreOptional()
		if (!store) return Promise.resolve({ columns: [], rows: [] })
		return store.query(sql, params as any)
	}

	async clearAll(): Promise<void> {
		const store = this.viewer.getStoreOptional()
		if (!store) return
		await store.clearAll()
	}

	async seed(kind: 'logs' | 'traces' | 'metrics' | 'mixed', count?: number): Promise<{ inserted: number }> {
		return await this.viewer.seed(kind, count)
	}
}
