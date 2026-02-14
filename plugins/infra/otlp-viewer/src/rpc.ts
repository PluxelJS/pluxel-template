import { RpcTarget } from '@pluxel/hmr/capnweb'
import type { OtlpSignal } from 'pluxel-plugin-otlp'
import type { OtlpViewer } from './index'
import type { OtlpViewerListOptions } from './protocol'
import type { OtlpViewerQueryResult, OtlpViewerStoreStats, OtlpViewerTraceDetail, OtlpViewerTraceSummaryRow } from './store'

export type { OtlpViewerFieldFilter, OtlpViewerFilterOp } from './protocol'
export type { OtlpViewerListOptions } from './protocol'

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
		return store.facetKeys(signal, opts, limits)
	}

	facetValues(
		signal: OtlpSignal,
		key: string,
		opts: OtlpViewerListOptions,
		limits?: { scanRows?: number; limitValues?: number },
	): Promise<{ key: string; values: Array<{ value: string; type: string; n: number }> }> {
		const store = this.viewer.getStoreOptional()
		if (!store) return Promise.resolve({ key: String(key ?? ''), values: [] })
		return store.facetValues(signal, key, opts, limits)
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
