import { DuckDBAppender, DuckDBConnection, DuckDBInstance, type DuckDBValue } from '@duckdb/node-api'

import type { OtlpAttributes, OtlpLogRecordInput, OtlpMetricPointInput, OtlpSignal, OtlpSpanInput, OtlpTapMeta } from 'pluxel-plugin-otlp'
import type { OtlpViewerConfig } from './config'
import type { OtlpViewerFieldFilter, OtlpViewerFilterOp, OtlpViewerListOptions } from './protocol'

export type OtlpViewerStoreStats = {
	enabled: boolean
	dbPath: string
	pending: { logs: number; spans: number; metrics: number }
	dropped: { logs: number; spans: number; metrics: number }
	lastError?: { at: number; message: string }
}

export type OtlpViewerQueryResult = {
	columns: string[]
	rows: Record<string, unknown>[]
}

export type OtlpViewerTraceSummaryRow = {
	trace_id: string
	start_ts_ms: number
	end_ts_ms: number
	duration_ms: number
	spans: number
	errors: number
	root_name: string
	caller_id: string
	caller_name: string
	service_name?: string
	scope_name?: string
	scope_version?: string
}

export type OtlpViewerTraceDetail = {
	traceId: string
	startTsMs: number
	endTsMs: number
	durationMs: number
	spans: number
	errors: number
	rows: Record<string, unknown>[]
}

type LogRow = {
	seq: number
	ts_ms: number
	level: string
	trace_id: string
	span_id: string
	body_json: string
	body_text: string
	attributes_json: string
	caller_id: string
	caller_name: string
}

type SpanRow = {
	seq: number
	trace_id: string
	span_id: string
	parent_span_id: string
	name: string
	kind: string
	status: string
	start_ts_ms: number
	end_ts_ms: number
	duration_ms: number
	error_json: string
	events_json: string
	attributes_json: string
	caller_id: string
	caller_name: string
}

type MetricRow = {
	seq: number
	ts_ms: number
	type: string
	name: string
	value: number
	unit: string
	description: string
	temporality: string
	monotonic: boolean
	bounds_json: string
	attributes_json: string
	caller_id: string
	caller_name: string
}

export class OtlpViewerDuckDbStore {
	private readonly cfg: OtlpViewerConfig
	private readonly dbPath: string
	private readonly maxPendingRows: number
	private instance: DuckDBInstance | null = null
	private conn: DuckDBConnection | null = null
	private appLogs: DuckDBAppender | null = null
	private appSpans: DuckDBAppender | null = null
	private appMetrics: DuckDBAppender | null = null

	private seq = 0

	private pendingLogs: LogRow[] = []
	private pendingSpans: SpanRow[] = []
	private pendingMetrics: MetricRow[] = []

	private droppedLogs = 0
	private droppedSpans = 0
	private droppedMetrics = 0

	private lastError: { at: number; message: string } | undefined

	private flushTimer: ReturnType<typeof setTimeout> | null = null
	private flushing: Promise<void> | null = null

	private constructor(cfg: OtlpViewerConfig) {
		this.cfg = cfg
		this.dbPath = String(cfg.dbPath ?? ':memory:') || ':memory:'
		const max = Math.floor(Number((cfg as any).maxPendingRows ?? 50_000))
		this.maxPendingRows = Number.isFinite(max) ? Math.max(0, max) : 50_000
	}

	static async create(cfg: OtlpViewerConfig): Promise<OtlpViewerDuckDbStore> {
		const store = new OtlpViewerDuckDbStore(cfg)
		await store.open()
		return store
	}

	stats(): OtlpViewerStoreStats {
		return {
			enabled: !!this.cfg.enabled,
			dbPath: this.dbPath,
			pending: { logs: this.pendingLogs.length, spans: this.pendingSpans.length, metrics: this.pendingMetrics.length },
			dropped: { logs: this.droppedLogs, spans: this.droppedSpans, metrics: this.droppedMetrics },
			...(this.lastError ? { lastError: this.lastError } : {}),
		}
	}

	async close(): Promise<void> {
		this.clearTimer()
		try {
			await this.flush()
		} catch {
			// best-effort
		}
		try {
			this.appLogs?.closeSync()
		} catch {
			// ignore
		}
		try {
			this.appSpans?.closeSync()
		} catch {
			// ignore
		}
		try {
			this.appMetrics?.closeSync()
		} catch {
			// ignore
		}
		this.appLogs = null
		this.appSpans = null
		this.appMetrics = null
		try {
			this.conn?.closeSync()
		} catch {
			// ignore
		}
		try {
			this.instance?.closeSync()
		} catch {
			// ignore
		}
		this.conn = null
		this.instance = null
	}

	ingestLogs(input: readonly OtlpLogRecordInput[], meta: OtlpTapMeta): void {
		if (!this.cfg.enabled) return
		for (const item of input) this.pendingLogs.push(toLogRow(++this.seq, item, meta))
		this.enforcePendingCap('logs')
		this.scheduleFlush()
	}

	ingestSpans(input: readonly OtlpSpanInput[], meta: OtlpTapMeta): void {
		if (!this.cfg.enabled) return
		for (const item of input) this.pendingSpans.push(toSpanRow(++this.seq, item, meta))
		this.enforcePendingCap('spans')
		this.scheduleFlush()
	}

	ingestMetrics(input: readonly OtlpMetricPointInput[], meta: OtlpTapMeta): void {
		if (!this.cfg.enabled) return
		for (const item of input) this.pendingMetrics.push(toMetricRow(++this.seq, item, meta))
		this.enforcePendingCap('metrics')
		this.scheduleFlush()
	}

	async flush(): Promise<void> {
		if (!this.cfg.enabled) return
		if (this.flushing) return await this.flushing
		this.flushing = this.flushOnce().finally(() => {
			this.flushing = null
		})
		return await this.flushing
	}

	async query(sql: string, params?: DuckDBValue[] | Record<string, DuckDBValue>): Promise<OtlpViewerQueryResult> {
		const conn = this.requireConn()
		const res = await conn.run(String(sql), params as any)
		const columns = res.columnNames()
		const rows = await res.getRowObjectsJS()
		return { columns, rows: rows.map((r) => jsonSafeRow(r)) }
	}

	async clearAll(): Promise<void> {
		const conn = this.requireConn()
		this.pendingLogs.length = 0
		this.pendingSpans.length = 0
		this.pendingMetrics.length = 0
		await conn.run('begin transaction;')
		try {
			await conn.run('delete from otlp_logs;')
			await conn.run('delete from otlp_spans;')
			await conn.run('delete from otlp_metrics;')
			await conn.run('commit;')
		} catch (error) {
			try {
				await conn.run('rollback;')
			} catch {
				// ignore
			}
			throw error
		}
	}

	async list(
		signal: OtlpSignal,
		opts: OtlpViewerListOptions,
	): Promise<{ total: number; rows: Record<string, unknown>[] }> {
		const conn = this.requireConn()
		const limit = clampInt(opts.limit ?? 200, 1, 2000)
		const offset = clampInt(opts.offset ?? 0, 0, 10_000_000)

		const where: string[] = []
		const params: DuckDBValue[] = []

		const callerId = String(opts.callerId ?? '').trim()
		if (callerId) {
			where.push('caller_id = ?')
			params.push(callerId)
		}

		let table = ''
		let order = ''
		let extra = ''
		let qWhere: string | null = null
		let tsCol = ''

		if (signal === 'logs') {
			table = 'otlp_logs'
			tsCol = 'ts_ms'
			order = 'ts_ms desc, seq desc'
			const level = String(opts.level ?? '').trim()
			if (level) {
				where.push('level = ?')
				params.push(level)
			}
			const q = String(opts.q ?? '').trim()
			if (q) {
				qWhere =
					'(lower(body_text) like lower(?) or lower(trace_id) like lower(?) or lower(span_id) like lower(?) or lower(attributes_json) like lower(?))'
				const like = `%${q}%`
				params.push(like, like, like, like)
			}
			extra = 'seq, ts_ms, level, trace_id, span_id, caller_id, caller_name, body_text, body_json, attributes_json'
		} else if (signal === 'traces') {
			table = 'otlp_spans'
			tsCol = 'start_ts_ms'
			order = 'start_ts_ms desc, seq desc'
			const status = String(opts.status ?? '').trim()
			if (status) {
				where.push('status = ?')
				params.push(status)
			}
			const name = String(opts.name ?? '').trim()
			if (name) {
				where.push('lower(name) like lower(?)')
				params.push(`%${name}%`)
			}
			const q = String(opts.q ?? '').trim()
			if (q) {
				qWhere =
					'(lower(name) like lower(?) or lower(trace_id) like lower(?) or lower(span_id) like lower(?) or lower(parent_span_id) like lower(?) or lower(attributes_json) like lower(?) or lower(error_json) like lower(?))'
				const like = `%${q}%`
				params.push(like, like, like, like, like, like)
			}
			extra = 'seq, start_ts_ms, end_ts_ms, duration_ms, status, kind, name, trace_id, span_id, parent_span_id, caller_id, caller_name, error_json, events_json, attributes_json'
		} else {
			table = 'otlp_metrics'
			tsCol = 'ts_ms'
			order = 'ts_ms desc, seq desc'
			const metricType = String(opts.metricType ?? '').trim()
			if (metricType) {
				where.push('type = ?')
				params.push(metricType)
			}
			const name = String(opts.name ?? '').trim()
			if (name) {
				where.push('lower(name) like lower(?)')
				params.push(`%${name}%`)
			}
			const q = String(opts.q ?? '').trim()
			if (q) {
				qWhere = '(lower(name) like lower(?) or lower(attributes_json) like lower(?))'
				const like = `%${q}%`
				params.push(like, like)
			}
			extra = 'seq, ts_ms, type, name, value, unit, temporality, monotonic, description, caller_id, caller_name, bounds_json, attributes_json'
		}

		const from = Number(opts.fromTsMs)
		if (Number.isFinite(from)) {
			where.push(`${tsCol} >= ?`)
			params.push(from)
		}
		const to = Number(opts.toTsMs)
		if (Number.isFinite(to)) {
			where.push(`${tsCol} <= ?`)
			params.push(to)
		}

		if (qWhere) where.push(qWhere)
		applyStructuredFilters(signal, opts.filters, where, params)
		const whereSql = where.length ? `where ${where.join(' and ')}` : ''
		const totalRes = await conn.run(`select count(*)::INTEGER as total from ${table} ${whereSql}`, params)
		const totalRows = await totalRes.getRowObjectsJS()
		const total = Number((totalRows[0] as any)?.total ?? 0)

		const dataRes = await conn.run(`select ${extra} from ${table} ${whereSql} order by ${order} limit ? offset ?`, [...params, limit, offset])
		const rows = await dataRes.getRowObjectsJS()
		return { total, rows: rows.map((r) => jsonSafeRow(r)) }
	}

	async listTraces(opts: OtlpViewerListOptions): Promise<{ total: number; rows: OtlpViewerTraceSummaryRow[] }> {
		const conn = this.requireConn()
		const limit = clampInt(opts.limit ?? 200, 1, 1000)
		const offset = clampInt(opts.offset ?? 0, 0, 10_000_000)

		const where: string[] = []
		const params: DuckDBValue[] = []

		const callerId = String(opts.callerId ?? '').trim()
		if (callerId) {
			where.push('caller_id = ?')
			params.push(callerId)
		}

		const status = String(opts.status ?? '').trim()
		if (status) {
			where.push('status = ?')
			params.push(status)
		}

		const name = String(opts.name ?? '').trim()
		if (name) {
			where.push('lower(name) like lower(?)')
			params.push(`%${name}%`)
		}

		const from = Number(opts.fromTsMs)
		if (Number.isFinite(from)) {
			where.push('start_ts_ms >= ?')
			params.push(from)
		}
		const to = Number(opts.toTsMs)
		if (Number.isFinite(to)) {
			where.push('start_ts_ms <= ?')
			params.push(to)
		}

		const q = String(opts.q ?? '').trim()
		if (q) {
			where.push(
				'(lower(trace_id) like lower(?) or lower(name) like lower(?) or lower(attributes_json) like lower(?) or lower(error_json) like lower(?))',
			)
			const like = `%${q}%`
			params.push(like, like, like, like)
		}

		applyStructuredFilters('traces', opts.filters, where, params)
		const whereSql = where.length ? `where ${where.join(' and ')}` : ''

		const totalRes = await conn.run(
			`
			with filtered as (
				select distinct trace_id
				from otlp_spans
				${whereSql}
			)
			select count(*)::INTEGER as total from filtered;
			`,
			params,
		)
		const totalRows = await totalRes.getRowObjectsJS()
		const total = Number((totalRows[0] as any)?.total ?? 0)

		const dataRes = await conn.run(
			`
			with filtered as (
				select distinct trace_id
				from otlp_spans
				${whereSql}
			),
			base as (
				select
					trace_id,
					min(start_ts_ms) as start_ts_ms,
					max(end_ts_ms) as end_ts_ms,
					(count(*))::INTEGER as spans,
					(sum(case when status = 'error' then 1 else 0 end))::INTEGER as errors,
					any_value(caller_id) as caller_id,
					any_value(caller_name) as caller_name,
					any_value(json_extract_string(attributes_json, '$.\"service.name\"')) as service_name,
					any_value(json_extract_string(attributes_json, '$.\"otel.scope.name\"')) as scope_name,
					any_value(json_extract_string(attributes_json, '$.\"otel.scope.version\"')) as scope_version
				from otlp_spans
				where trace_id in (select trace_id from filtered)
				group by trace_id
			),
			roots as (
				select trace_id, name as root_name
				from (
					select
						trace_id,
						name,
						row_number() over (partition by trace_id order by start_ts_ms asc, seq asc) as rn
					from otlp_spans
					where trace_id in (select trace_id from filtered) and (parent_span_id = '' or parent_span_id is null)
				)
				where rn = 1
			)
			select
				base.trace_id,
				base.start_ts_ms,
				base.end_ts_ms,
				(base.end_ts_ms - base.start_ts_ms) as duration_ms,
				base.spans,
				base.errors,
				coalesce(roots.root_name, '') as root_name,
				base.caller_id,
				base.caller_name,
				base.service_name,
				base.scope_name,
				base.scope_version
			from base
			left join roots using (trace_id)
			order by base.start_ts_ms desc
			limit ? offset ?;
			`,
			[...params, limit, offset],
		)
		const rows = await dataRes.getRowObjectsJS()
		return { total, rows: rows.map((r) => jsonSafeRow(r) as any) }
	}

	async getTrace(traceId: string): Promise<OtlpViewerTraceDetail> {
		const conn = this.requireConn()
		const id = String(traceId ?? '').trim()
		if (!id) return { traceId: '', startTsMs: 0, endTsMs: 0, durationMs: 0, spans: 0, errors: 0, rows: [] }

		const statsRes = await conn.run(
			`
			select
				min(start_ts_ms) as start_ts_ms,
				max(end_ts_ms) as end_ts_ms,
				(count(*))::INTEGER as spans,
				(sum(case when status = 'error' then 1 else 0 end))::INTEGER as errors
			from otlp_spans
			where trace_id = ?;
			`,
			[id],
		)
		const statsRows = await statsRes.getRowObjectsJS()
		const startTsMs = Number((statsRows[0] as any)?.start_ts_ms ?? 0)
		const endTsMs = Number((statsRows[0] as any)?.end_ts_ms ?? 0)
		const spans = Number((statsRows[0] as any)?.spans ?? 0)
		const errors = Number((statsRows[0] as any)?.errors ?? 0)
		const durationMs = Math.max(0, endTsMs - startTsMs)

		const dataRes = await conn.run(
			`
			select
				seq,
				trace_id,
				span_id,
				parent_span_id,
				name,
				kind,
				status,
				start_ts_ms,
				end_ts_ms,
				duration_ms,
				error_json,
				events_json,
				attributes_json,
				caller_id,
				caller_name
			from otlp_spans
			where trace_id = ?
			order by start_ts_ms asc, seq asc;
			`,
			[id],
		)
		const rows = await dataRes.getRowObjectsJS()
		return {
			traceId: id,
			startTsMs: Number.isFinite(startTsMs) ? startTsMs : 0,
			endTsMs: Number.isFinite(endTsMs) ? endTsMs : 0,
			durationMs,
			spans,
			errors,
			rows: rows.map((r) => jsonSafeRow(r)),
		}
	}

	async facetKeys(
		signal: OtlpSignal,
		opts: OtlpViewerListOptions,
		limits?: { scanRows?: number; limitKeys?: number },
	): Promise<{ keys: Array<{ key: string; n: number }> }> {
		const conn = this.requireConn()
		const scanRows = clampInt(Number(limits?.scanRows ?? 20_000), 100, 200_000)
		const limitKeys = clampInt(Number(limits?.limitKeys ?? 80), 1, 500)

		const where: string[] = []
		const params: DuckDBValue[] = []

		const callerId = String(opts.callerId ?? '').trim()
		if (callerId) {
			where.push('caller_id = ?')
			params.push(callerId)
		}

		let table = ''
		let tsCol = ''
		let qWhere: string | null = null

		if (signal === 'logs') {
			table = 'otlp_logs'
			tsCol = 'ts_ms'
			const level = String(opts.level ?? '').trim()
			if (level) {
				where.push('level = ?')
				params.push(level)
			}
			const q = String(opts.q ?? '').trim()
			if (q) {
				qWhere =
					'(lower(body_text) like lower(?) or lower(trace_id) like lower(?) or lower(span_id) like lower(?) or lower(attributes_json) like lower(?))'
				const like = `%${q}%`
				params.push(like, like, like, like)
			}
		} else if (signal === 'traces') {
			table = 'otlp_spans'
			tsCol = 'start_ts_ms'
			const status = String(opts.status ?? '').trim()
			if (status) {
				where.push('status = ?')
				params.push(status)
			}
			const name = String(opts.name ?? '').trim()
			if (name) {
				where.push('lower(name) like lower(?)')
				params.push(`%${name}%`)
			}
			const q = String(opts.q ?? '').trim()
			if (q) {
				qWhere =
					'(lower(name) like lower(?) or lower(trace_id) like lower(?) or lower(span_id) like lower(?) or lower(parent_span_id) like lower(?) or lower(attributes_json) like lower(?) or lower(error_json) like lower(?))'
				const like = `%${q}%`
				params.push(like, like, like, like, like, like)
			}
		} else {
			table = 'otlp_metrics'
			tsCol = 'ts_ms'
			const metricType = String(opts.metricType ?? '').trim()
			if (metricType) {
				where.push('type = ?')
				params.push(metricType)
			}
			const name = String(opts.name ?? '').trim()
			if (name) {
				where.push('lower(name) like lower(?)')
				params.push(`%${name}%`)
			}
			const q = String(opts.q ?? '').trim()
			if (q) {
				qWhere = '(lower(name) like lower(?) or lower(attributes_json) like lower(?))'
				const like = `%${q}%`
				params.push(like, like)
			}
		}

		const from = Number(opts.fromTsMs)
		if (Number.isFinite(from)) {
			where.push(`${tsCol} >= ?`)
			params.push(from)
		}
		const to = Number(opts.toTsMs)
		if (Number.isFinite(to)) {
			where.push(`${tsCol} <= ?`)
			params.push(to)
		}

		if (qWhere) where.push(qWhere)
		applyStructuredFilters(signal, opts.filters, where, params)

		const whereSql = where.length ? `where ${where.join(' and ')}` : ''
		const baseSql = `select attributes_json from ${table} ${whereSql} order by ${tsCol} desc, seq desc limit ?`
		const sql = `
			select je.key as key, count(*)::INTEGER as n
			from (${baseSql}) as b, json_each(b.attributes_json) as je
			group by je.key
			order by n desc, je.key asc
			limit ?;
		`

		const res = await conn.run(sql, [...params, scanRows, limitKeys])
		const rows = await res.getRowObjectsJS()
		return {
			keys: rows
				.map((r: any) => ({ key: String(r?.key ?? ''), n: Number(r?.n ?? 0) }))
				.filter((r) => !!r.key && Number.isFinite(r.n) && r.n > 0),
		}
	}

	async facetValues(
		signal: OtlpSignal,
		key: string,
		opts: OtlpViewerListOptions,
		limits?: { scanRows?: number; limitValues?: number },
	): Promise<{ key: string; values: Array<{ value: string; type: string; n: number }> }> {
		const conn = this.requireConn()
		const k = String(key ?? '').trim()
		if (!k) return { key: '', values: [] }

		const scanRows = clampInt(Number(limits?.scanRows ?? 20_000), 100, 200_000)
		const limitValues = clampInt(Number(limits?.limitValues ?? 80), 1, 500)

		const where: string[] = []
		const params: DuckDBValue[] = []

		const callerId = String(opts.callerId ?? '').trim()
		if (callerId) {
			where.push('caller_id = ?')
			params.push(callerId)
		}

		let table = ''
		let tsCol = ''
		let qWhere: string | null = null

		if (signal === 'logs') {
			table = 'otlp_logs'
			tsCol = 'ts_ms'
			const level = String(opts.level ?? '').trim()
			if (level) {
				where.push('level = ?')
				params.push(level)
			}
			const q = String(opts.q ?? '').trim()
			if (q) {
				qWhere =
					'(lower(body_text) like lower(?) or lower(trace_id) like lower(?) or lower(span_id) like lower(?) or lower(attributes_json) like lower(?))'
				const like = `%${q}%`
				params.push(like, like, like, like)
			}
		} else if (signal === 'traces') {
			table = 'otlp_spans'
			tsCol = 'start_ts_ms'
			const status = String(opts.status ?? '').trim()
			if (status) {
				where.push('status = ?')
				params.push(status)
			}
			const name = String(opts.name ?? '').trim()
			if (name) {
				where.push('lower(name) like lower(?)')
				params.push(`%${name}%`)
			}
			const q = String(opts.q ?? '').trim()
			if (q) {
				qWhere =
					'(lower(name) like lower(?) or lower(trace_id) like lower(?) or lower(span_id) like lower(?) or lower(parent_span_id) like lower(?) or lower(attributes_json) like lower(?) or lower(error_json) like lower(?))'
				const like = `%${q}%`
				params.push(like, like, like, like, like, like)
			}
		} else {
			table = 'otlp_metrics'
			tsCol = 'ts_ms'
			const metricType = String(opts.metricType ?? '').trim()
			if (metricType) {
				where.push('type = ?')
				params.push(metricType)
			}
			const name = String(opts.name ?? '').trim()
			if (name) {
				where.push('lower(name) like lower(?)')
				params.push(`%${name}%`)
			}
			const q = String(opts.q ?? '').trim()
			if (q) {
				qWhere = '(lower(name) like lower(?) or lower(attributes_json) like lower(?))'
				const like = `%${q}%`
				params.push(like, like)
			}
		}

		const from = Number(opts.fromTsMs)
		if (Number.isFinite(from)) {
			where.push(`${tsCol} >= ?`)
			params.push(from)
		}
		const to = Number(opts.toTsMs)
		if (Number.isFinite(to)) {
			where.push(`${tsCol} <= ?`)
			params.push(to)
		}

		if (qWhere) where.push(qWhere)
		applyStructuredFilters(signal, opts.filters, where, params)

		const whereSql = where.length ? `where ${where.join(' and ')}` : ''
		const baseSql = `select attributes_json from ${table} ${whereSql} order by ${tsCol} desc, seq desc limit ?`
		const sql = `
			select
				json_extract_string(je.value, '$') as value,
				je.type as type,
				count(*)::INTEGER as n
			from (${baseSql}) as b, json_each(b.attributes_json) as je
			where je.key = ?
			group by value, type
			order by n desc, value asc
			limit ?;
		`

		const res = await conn.run(sql, [...params, scanRows, k, limitValues])
		const rows = await res.getRowObjectsJS()
		return {
			key: k,
			values: rows
				.map((r: any) => ({ value: String(r?.value ?? ''), type: String(r?.type ?? ''), n: Number(r?.n ?? 0) }))
				.filter((r) => Number.isFinite(r.n) && r.n > 0),
		}
	}

	private async open(): Promise<void> {
		this.instance = await DuckDBInstance.create(this.dbPath)
		this.conn = await this.instance.connect()
		await this.initSchema()
		try {
			this.appLogs = await this.conn.createAppender('otlp_logs')
			this.appSpans = await this.conn.createAppender('otlp_spans')
			this.appMetrics = await this.conn.createAppender('otlp_metrics')
		} catch {
			this.appLogs = null
			this.appSpans = null
			this.appMetrics = null
		}
	}

	private requireConn(): DuckDBConnection {
		if (!this.conn) throw new Error('[otlp-viewer.store] DuckDB connection not initialized')
		return this.conn
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return
		const delay = clampInt(this.cfg.flushIntervalMs ?? 200, 5, 60_000)
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null
			void this.flush()
		}, delay)
	}

	private clearTimer(): void {
		if (!this.flushTimer) return
		clearTimeout(this.flushTimer)
		this.flushTimer = null
	}

	private async initSchema(): Promise<void> {
		const conn = this.requireConn()
		await conn.run(`
			create table if not exists otlp_logs (
				seq double,
				ts_ms double,
				level varchar,
				trace_id varchar,
				span_id varchar,
				body_json varchar,
				body_text varchar,
				attributes_json varchar,
				caller_id varchar,
				caller_name varchar
			);
		`)
		await ensureLogsSchema(conn)
		await conn.run(`
			create table if not exists otlp_spans (
				seq double,
				trace_id varchar,
				span_id varchar,
				parent_span_id varchar,
				name varchar,
				kind varchar,
				status varchar,
				start_ts_ms double,
				end_ts_ms double,
				duration_ms double,
				error_json varchar,
				events_json varchar,
				attributes_json varchar,
				caller_id varchar,
				caller_name varchar
			);
		`)
		await conn.run(`
			create table if not exists otlp_metrics (
				seq double,
				ts_ms double,
				type varchar,
				name varchar,
				value double,
				unit varchar,
				description varchar,
				temporality varchar,
				monotonic boolean,
				bounds_json varchar,
				attributes_json varchar,
				caller_id varchar,
				caller_name varchar
			);
		`)
		await conn.run('create index if not exists otlp_logs_ts on otlp_logs(ts_ms);')
		await conn.run('create index if not exists otlp_logs_caller on otlp_logs(caller_id);')
		await conn.run('create index if not exists otlp_logs_trace on otlp_logs(trace_id);')
		await conn.run('create index if not exists otlp_logs_span on otlp_logs(span_id);')
		await conn.run('create index if not exists otlp_spans_start on otlp_spans(start_ts_ms);')
		await conn.run('create index if not exists otlp_spans_caller on otlp_spans(caller_id);')
		await conn.run('create index if not exists otlp_metrics_ts on otlp_metrics(ts_ms);')
		await conn.run('create index if not exists otlp_metrics_caller on otlp_metrics(caller_id);')
	}

	private enforcePendingCap(table: 'logs' | 'spans' | 'metrics'): void {
		const max = this.maxPendingRows
		if (max <= 0) return

		if (table === 'logs') {
			const over = this.pendingLogs.length - max
			if (over > 0) {
				this.pendingLogs.splice(0, over)
				this.droppedLogs += over
			}
			return
		}
		if (table === 'spans') {
			const over = this.pendingSpans.length - max
			if (over > 0) {
				this.pendingSpans.splice(0, over)
				this.droppedSpans += over
			}
			return
		}
		const over = this.pendingMetrics.length - max
		if (over > 0) {
			this.pendingMetrics.splice(0, over)
			this.droppedMetrics += over
		}
	}

	private async flushOnce(): Promise<void> {
		const conn = this.requireConn()
		this.clearTimer()

		const maxBatchRows = clampInt(this.cfg.maxBatchRows ?? 2000, 1, 100_000)
		const logs = this.pendingLogs.slice(0, maxBatchRows)
		const spans = this.pendingSpans.slice(0, maxBatchRows)
		const metrics = this.pendingMetrics.slice(0, maxBatchRows)

		if (!logs.length && !spans.length && !metrics.length) return

		try {
			await conn.run('begin transaction;')
			if (logs.length) await insertLogs(conn, this.appLogs, logs)
			if (spans.length) await insertSpans(conn, this.appSpans, spans)
			if (metrics.length) await insertMetrics(conn, this.appMetrics, metrics)

			await this.applyRetention(conn)
			await conn.run('commit;')

			if (logs.length) this.pendingLogs.splice(0, logs.length)
			if (spans.length) this.pendingSpans.splice(0, spans.length)
			if (metrics.length) this.pendingMetrics.splice(0, metrics.length)
		} catch (error) {
			try {
				await conn.run('rollback;')
			} catch {
				// ignore
			}

			this.lastError = {
				at: Date.now(),
				message: error instanceof Error ? error.message : String(error),
			}
		} finally {
			if (this.pendingLogs.length || this.pendingSpans.length || this.pendingMetrics.length) {
				this.scheduleFlush()
			}
		}
	}

	private async applyRetention(conn: DuckDBConnection): Promise<void> {
		const { maxLogs, maxSpans, maxMetrics } = this.cfg.retention
		await applyRetentionBySeq(conn, 'otlp_logs', Math.max(0, Math.floor(maxLogs ?? 0)))
		await applyRetentionBySeq(conn, 'otlp_spans', Math.max(0, Math.floor(maxSpans ?? 0)))
		await applyRetentionBySeq(conn, 'otlp_metrics', Math.max(0, Math.floor(maxMetrics ?? 0)))
	}
}

async function insertLogs(conn: DuckDBConnection, app: DuckDBAppender | null, rows: readonly LogRow[]): Promise<void> {
	if (app) {
		for (const r of rows) {
			app.appendDouble(r.seq)
			app.appendDouble(r.ts_ms)
			app.appendVarchar(r.level)
			app.appendVarchar(r.trace_id)
			app.appendVarchar(r.span_id)
			app.appendVarchar(r.body_json)
			app.appendVarchar(r.body_text)
			app.appendVarchar(r.attributes_json)
			app.appendVarchar(r.caller_id)
			app.appendVarchar(r.caller_name)
			app.endRow()
		}
		app.flushSync()
		return
	}

	const values: string[] = []
	const params: DuckDBValue[] = []
	for (const r of rows) {
		values.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
		params.push(r.seq, r.ts_ms, r.level, r.trace_id, r.span_id, r.body_json, r.body_text, r.attributes_json, r.caller_id, r.caller_name)
	}
	await conn.run(
		`insert into otlp_logs (seq, ts_ms, level, trace_id, span_id, body_json, body_text, attributes_json, caller_id, caller_name) values ${values.join(',')};`,
		params,
	)
}

async function insertSpans(conn: DuckDBConnection, app: DuckDBAppender | null, rows: readonly SpanRow[]): Promise<void> {
	if (app) {
		for (const r of rows) {
			app.appendDouble(r.seq)
			app.appendVarchar(r.trace_id)
			app.appendVarchar(r.span_id)
			app.appendVarchar(r.parent_span_id)
			app.appendVarchar(r.name)
			app.appendVarchar(r.kind)
			app.appendVarchar(r.status)
			app.appendDouble(r.start_ts_ms)
			app.appendDouble(r.end_ts_ms)
			app.appendDouble(r.duration_ms)
			app.appendVarchar(r.error_json)
			app.appendVarchar(r.events_json)
			app.appendVarchar(r.attributes_json)
			app.appendVarchar(r.caller_id)
			app.appendVarchar(r.caller_name)
			app.endRow()
		}
		app.flushSync()
		return
	}

	const values: string[] = []
	const params: DuckDBValue[] = []
	for (const r of rows) {
		values.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
		params.push(
			r.seq,
			r.trace_id,
			r.span_id,
			r.parent_span_id,
			r.name,
			r.kind,
			r.status,
			r.start_ts_ms,
			r.end_ts_ms,
			r.duration_ms,
			r.error_json,
			r.events_json,
			r.attributes_json,
			r.caller_id,
			r.caller_name,
		)
	}
	await conn.run(`insert into otlp_spans values ${values.join(',')};`, params)
}

async function insertMetrics(conn: DuckDBConnection, app: DuckDBAppender | null, rows: readonly MetricRow[]): Promise<void> {
	if (app) {
		for (const r of rows) {
			app.appendDouble(r.seq)
			app.appendDouble(r.ts_ms)
			app.appendVarchar(r.type)
			app.appendVarchar(r.name)
			app.appendDouble(r.value)
			app.appendVarchar(r.unit)
			app.appendVarchar(r.description)
			app.appendVarchar(r.temporality)
			app.appendBoolean(r.monotonic)
			app.appendVarchar(r.bounds_json)
			app.appendVarchar(r.attributes_json)
			app.appendVarchar(r.caller_id)
			app.appendVarchar(r.caller_name)
			app.endRow()
		}
		app.flushSync()
		return
	}

	const values: string[] = []
	const params: DuckDBValue[] = []
	for (const r of rows) {
		values.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
		params.push(
			r.seq,
			r.ts_ms,
			r.type,
			r.name,
			r.value,
			r.unit,
			r.description,
			r.temporality,
			r.monotonic,
			r.bounds_json,
			r.attributes_json,
			r.caller_id,
			r.caller_name,
		)
	}
	await conn.run(`insert into otlp_metrics values ${values.join(',')};`, params)
}

async function applyRetentionBySeq(conn: DuckDBConnection, table: string, maxRows: number): Promise<void> {
	if (maxRows <= 0) {
		await conn.run(`delete from ${table};`)
		return
	}
	const boundary = await conn.run(`select seq from ${table} order by seq desc limit 1 offset ?`, [maxRows])
	const rows = await boundary.getRowObjectsJS()
	const seq = Number((rows[0] as any)?.seq ?? NaN)
	if (!Number.isFinite(seq)) return
	await conn.run(`delete from ${table} where seq <= ?`, [seq])
}

async function ensureLogsSchema(conn: DuckDBConnection): Promise<void> {
	const want = ['seq', 'ts_ms', 'level', 'trace_id', 'span_id', 'body_json', 'body_text', 'attributes_json', 'caller_id', 'caller_name']

	let cols: string[] = []
	try {
		const res = await conn.run(`pragma table_info('otlp_logs');`)
		const rows = await res.getRowObjectsJS()
		cols = rows.map((r: any) => String(r?.name ?? '')).filter(Boolean)
	} catch {
		cols = []
	}

	if (cols.length === 0) return
	if (cols.join(',') === want.join(',')) return

	const hasTraceId = cols.includes('trace_id')
	const hasSpanId = cols.includes('span_id')
	const hasBodyJson = cols.includes('body_json')
	const hasBodyText = cols.includes('body_text')
	const hasAttrs = cols.includes('attributes_json')
	const hasCallerId = cols.includes('caller_id')
	const hasCallerName = cols.includes('caller_name')

	if (!cols.includes('seq') || !cols.includes('ts_ms') || !cols.includes('level') || !hasBodyJson || !hasBodyText || !hasAttrs || !hasCallerId || !hasCallerName) {
		return
	}

	await conn.run('begin transaction;')
	try {
		await conn.run('drop table if exists otlp_logs__migr;')
		await conn.run(`
			create table otlp_logs__migr (
				seq double,
				ts_ms double,
				level varchar,
				trace_id varchar,
				span_id varchar,
				body_json varchar,
				body_text varchar,
				attributes_json varchar,
				caller_id varchar,
				caller_name varchar
			);
		`)
		await conn.run(
			`
			insert into otlp_logs__migr (seq, ts_ms, level, trace_id, span_id, body_json, body_text, attributes_json, caller_id, caller_name)
			select
				seq,
				ts_ms,
				level,
				${hasTraceId ? 'trace_id' : "''"} as trace_id,
				${hasSpanId ? 'span_id' : "''"} as span_id,
				body_json,
				body_text,
				attributes_json,
				caller_id,
				caller_name
			from otlp_logs;
			`,
		)
		await conn.run('drop table otlp_logs;')
		await conn.run('alter table otlp_logs__migr rename to otlp_logs;')
		await conn.run('commit;')
	} catch (error) {
		try {
			await conn.run('rollback;')
		} catch {
			// ignore
		}
		throw error
	}
}

function toLogRow(seq: number, item: OtlpLogRecordInput, meta: OtlpTapMeta): LogRow {
	const ts_ms = typeof item.tsMs === 'number' ? item.tsMs : Date.now()
	const level = String(item.level ?? 'info')
	const trace_id = String((item as any).traceId ?? '').trim()
	const span_id = String((item as any).spanId ?? '').trim()
	const body_json = safeJson(item.body)
	const body_text = safeText(item.body)
	const scopeAttrs = {
		...(meta.scope?.name ? { 'otel.scope.name': meta.scope.name } : {}),
		...(meta.scope?.version ? { 'otel.scope.version': meta.scope.version } : {}),
	}
	const attributes_json = safeJson({ ...(meta.resourceAttrs ?? {}), ...scopeAttrs, ...(meta.attrs ?? {}), ...(item.attributes ?? {}) })
	return {
		seq,
		ts_ms,
		level,
		trace_id,
		span_id,
		body_json,
		body_text,
		attributes_json,
		caller_id: meta.callerId,
		caller_name: meta.callerName,
	}
}

function toSpanRow(seq: number, item: OtlpSpanInput, meta: OtlpTapMeta): SpanRow {
	const traceId = String(item.traceId ?? '').trim()
	const spanId = String(item.spanId ?? '').trim()
	const parentSpanId = String(item.parentSpanId ?? '').trim()
	const name = String(item.name ?? '').trim()
	const kind = String(item.kind ?? 'internal')
	const status = String(item.status ?? 'unset')
	const start_ts_ms = typeof item.startTsMs === 'number' ? item.startTsMs : Date.now()
	const end_ts_ms = typeof item.endTsMs === 'number' ? item.endTsMs : start_ts_ms
	const duration_ms = Math.max(0, end_ts_ms - start_ts_ms)
	const error_json = safeJson(item.error ?? null)
	const events_json = safeJson(item.events ?? [])
	const scopeAttrs = {
		...(meta.scope?.name ? { 'otel.scope.name': meta.scope.name } : {}),
		...(meta.scope?.version ? { 'otel.scope.version': meta.scope.version } : {}),
	}
	const attributes_json = safeJson({ ...(meta.resourceAttrs ?? {}), ...scopeAttrs, ...(meta.attrs ?? {}), ...(item.attributes ?? {}) })
	return {
		seq,
		trace_id: traceId,
		span_id: spanId,
		parent_span_id: parentSpanId,
		name,
		kind,
		status,
		start_ts_ms,
		end_ts_ms,
		duration_ms,
		error_json,
		events_json,
		attributes_json,
		caller_id: meta.callerId,
		caller_name: meta.callerName,
	}
}

function toMetricRow(seq: number, item: OtlpMetricPointInput, meta: OtlpTapMeta): MetricRow {
	const ts_ms = typeof item.tsMs === 'number' ? item.tsMs : Date.now()
	const type = String((item as any).type ?? '')
	const name = String(item.name ?? '')
	const value = Number((item as any).value ?? 0)
	const unit = String((item as any).unit ?? '')
	const description = String((item as any).description ?? '')
	const temporality = String((item as any).temporality ?? '')
	const monotonic = Boolean((item as any).monotonic ?? false)
	const bounds_json = safeJson((item as any).bounds ?? [])
	const scopeAttrs = {
		...(meta.scope?.name ? { 'otel.scope.name': meta.scope.name } : {}),
		...(meta.scope?.version ? { 'otel.scope.version': meta.scope.version } : {}),
	}
	const attributes_json = safeJson({ ...(meta.resourceAttrs ?? {}), ...scopeAttrs, ...(meta.attrs ?? {}), ...(item.attributes ?? {}) })
	return {
		seq,
		ts_ms,
		type,
		name,
		value,
		unit,
		description,
		temporality,
		monotonic,
		bounds_json,
		attributes_json,
		caller_id: meta.callerId,
		caller_name: meta.callerName,
	}
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, (_k, v2) => {
			if (typeof v2 === 'bigint') return v2.toString()
			if (v2 instanceof Error) return { name: v2.name, message: v2.message, stack: v2.stack }
			return v2
		})
	} catch {
		try {
			return JSON.stringify(String(value))
		} catch {
			return '""'
		}
	}
}

function safeText(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
	if (value instanceof Error) return `${value.name}: ${value.message}`
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

function jsonSafeRow(row: Record<string, any>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(row)) out[k] = jsonSafeValue(v)
	return out
}

function jsonSafeValue(value: any): any {
	if (typeof value === 'bigint') {
		const n = Number(value)
		return Number.isSafeInteger(n) ? n : value.toString()
	}
	if (Array.isArray(value)) return value.map((v) => jsonSafeValue(v))
	if (value && typeof value === 'object') {
		const out: any = {}
		for (const [k, v] of Object.entries(value)) out[k] = jsonSafeValue(v)
		return out
	}
	return value
}

function clampInt(n: number, min: number, max: number): number {
	const x = Math.floor(Number(n))
	if (!Number.isFinite(x)) return min
	return Math.max(min, Math.min(max, x))
}

function applyStructuredFilters(
	signal: OtlpSignal,
	filters: readonly OtlpViewerFieldFilter[] | undefined,
	where: string[],
	params: DuckDBValue[],
): void {
	if (!filters?.length) return
	for (const f of filters) {
		const sql = filterToSql(signal, f, params)
		if (sql) where.push(sql)
	}
}

function filterToSql(signal: OtlpSignal, filter: OtlpViewerFieldFilter, params: DuckDBValue[]): string | null {
	const fieldRaw = String(filter?.field ?? '').trim()
	const op = String(filter?.op ?? '').trim() as OtlpViewerFilterOp
	if (!fieldRaw || !op) return null

	const { expr, kind } = resolveFilterExpr(signal, fieldRaw)
	if (!expr) return null

	const vRaw = filter?.value
	const v = typeof vRaw === 'string' ? vRaw : vRaw === undefined ? '' : String(vRaw)

	if (op === 'exists') {
		return kind === 'attr' ? `(${expr} is not null and ${expr} != '')` : `(${expr} is not null)`
	}

	if (op === 'contains') {
		if (!v) return null
		params.push(`%${v}%`)
		return `(lower(${expr}) like lower(?))`
	}

	if (op === 'like') {
		if (!v) return null
		params.push(v)
		return `(lower(${expr}) like lower(?))`
	}

	if (op === 'eq') {
		if (!v) return null
		params.push(v)
		return `(${expr} = ?)`
	}

	if (op === 'neq') {
		if (!v) return null
		params.push(v)
		return `(${expr} != ?)`
	}

	if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
		if (!v) return null
		const n = Number(v)
		if (!Number.isFinite(n)) return null
		params.push(n)
		const cmp = op === 'gt' ? '>' : op === 'gte' ? '>=' : op === 'lt' ? '<' : '<='
		return `(try_cast(${expr} as double) ${cmp} ?)`
	}

	return null
}

function resolveFilterExpr(signal: OtlpSignal, field: string): { expr: string | null; kind: 'col' | 'attr' } {
	const f = field.trim()

	if (f.startsWith('attr.')) {
		const key = f.slice('attr.'.length).trim()
		if (!key) return { expr: null, kind: 'attr' }
		const jsonPathKey = key.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
		return { expr: `json_extract_string(attributes_json, '$.\"${jsonPathKey}\"')`, kind: 'attr' }
	}

	const norm = f.replaceAll('-', '_')
	const lower = norm.toLowerCase()

	const mapCommon: Record<string, string> = {
		callerid: 'caller_id',
		caller_id: 'caller_id',
		traceid: 'trace_id',
		trace_id: 'trace_id',
		spanid: 'span_id',
		span_id: 'span_id',
		parentspanid: 'parent_span_id',
		parent_span_id: 'parent_span_id',
		level: 'level',
		status: 'status',
		kind: 'kind',
		name: 'name',
		type: 'type',
		tsms: 'ts_ms',
		ts_ms: 'ts_ms',
		starttsms: 'start_ts_ms',
		start_ts_ms: 'start_ts_ms',
		durationms: 'duration_ms',
		duration_ms: 'duration_ms',
		value: 'value',
	}

	const col = mapCommon[lower]
	if (!col) return { expr: null, kind: 'col' }

	if (signal === 'logs') {
		const allowed = new Set(['caller_id', 'trace_id', 'span_id', 'level', 'ts_ms'])
		return { expr: allowed.has(col) ? col : null, kind: 'col' }
	}
	if (signal === 'traces') {
		const allowed = new Set(['caller_id', 'trace_id', 'span_id', 'parent_span_id', 'status', 'kind', 'name', 'start_ts_ms', 'duration_ms'])
		return { expr: allowed.has(col) ? col : null, kind: 'col' }
	}
	const allowed = new Set(['caller_id', 'type', 'name', 'ts_ms', 'value'])
	return { expr: allowed.has(col) ? col : null, kind: 'col' }
}
