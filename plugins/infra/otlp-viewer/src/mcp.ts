import type { Context } from '@pluxel/hmr'
import { toJsonSchema } from '@valibot/to-json-schema'
import {
	InMemorySessionAdapter,
	McpServer,
	StreamableHttpTransport,
	type ToolCallResult,
} from 'mcp-lite'
import * as v from 'valibot'
import type { OtlpSignal } from 'pluxel-plugin-otlp'

import type { OtlpViewerFieldFilter, OtlpViewerFilterOp, OtlpViewerListOptions } from './protocol'
import type { OtlpViewerQueryResult, OtlpViewerStoreStats, OtlpViewerTraceDetail, OtlpViewerTraceSummaryRow } from './store'
import type { OtlpViewerDuckDbStore } from './store'

const textContent = (text: string) => ({ type: 'text' as const, text })
const textResult = <T>(text: string, structuredContent: T): ToolCallResult<T> => ({
	content: [textContent(text)],
	structuredContent,
})

const SignalSchema = v.picklist(['logs', 'traces', 'metrics'])
const FilterOpSchema: v.GenericSchema<OtlpViewerFilterOp> = v.picklist([
	'eq',
	'neq',
	'contains',
	'like',
	'exists',
	'gt',
	'gte',
	'lt',
	'lte',
])
const FieldFilterSchema: v.GenericSchema<OtlpViewerFieldFilter> = v.object({
	field: v.string(),
	op: FilterOpSchema,
	value: v.optional(v.string()),
})

const ListOptionsSchema: v.GenericSchema<OtlpViewerListOptions> = v.object({
	q: v.optional(v.string()),
	callerId: v.optional(v.string()),
	fromTsMs: v.optional(v.number()),
	toTsMs: v.optional(v.number()),
	limit: v.optional(v.number()),
	offset: v.optional(v.number()),
	level: v.optional(v.string()),
	status: v.optional(v.string()),
	name: v.optional(v.string()),
	metricType: v.optional(v.string()),
	filters: v.optional(v.array(FieldFilterSchema)),
})

const StoreStatsSchema = v.object({
	enabled: v.boolean(),
	dbPath: v.string(),
	pending: v.object({ logs: v.number(), spans: v.number(), metrics: v.number() }),
	dropped: v.object({ logs: v.number(), spans: v.number(), metrics: v.number() }),
	lastError: v.optional(v.object({ at: v.number(), message: v.string() })),
})

const ListOutputSchema = v.object({
	total: v.number(),
	rows: v.array(v.record(v.string(), v.unknown())),
})

const ListTextOutputSchema = v.object({
	text: v.string(),
	total: v.number(),
	shown: v.number(),
	rows: v.array(v.record(v.string(), v.unknown())),
})

const TraceSummarySchema = v.object({
	trace_id: v.string(),
	start_ts_ms: v.number(),
	end_ts_ms: v.number(),
	duration_ms: v.number(),
	spans: v.number(),
	errors: v.number(),
	root_name: v.string(),
	caller_id: v.string(),
	caller_name: v.string(),
	service_name: v.optional(v.string()),
	scope_name: v.optional(v.string()),
	scope_version: v.optional(v.string()),
})

const ListTracesOutputSchema = v.object({
	total: v.number(),
	rows: v.array(TraceSummarySchema),
})

const TraceDetailSchema = v.object({
	traceId: v.string(),
	startTsMs: v.number(),
	endTsMs: v.number(),
	durationMs: v.number(),
	spans: v.number(),
	errors: v.number(),
	rows: v.array(v.record(v.string(), v.unknown())),
})

const QueryInputSchema = v.object({
	sql: v.string(),
	params: v.optional(v.unknown()),
})

const QueryOutputSchema = v.object({
	columns: v.array(v.string()),
	rows: v.array(v.record(v.string(), v.unknown())),
})

const FacetKeysOutputSchema = v.object({
	keys: v.array(v.object({ key: v.string(), n: v.number() })),
})

const FacetValuesOutputSchema = v.object({
	key: v.string(),
	values: v.array(v.object({ value: v.string(), type: v.string(), n: v.number() })),
})

function clampInt(n: unknown, min: number, max: number): number {
	const x = Math.floor(Number(n))
	if (!Number.isFinite(x)) return min
	return Math.max(min, Math.min(max, x))
}

function pickStr(row: Record<string, unknown>, key: string): string {
	const v = row[key]
	return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)
}

function pickNum(row: Record<string, unknown>, key: string): number {
	const v = row[key]
	const n = typeof v === 'number' ? v : Number(v)
	return Number.isFinite(n) ? n : 0
}

function fmtTs(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return ''
	try {
		return new Date(ms).toISOString()
	} catch {
		return String(ms)
	}
}

function rowsToText(signal: OtlpSignal, rows: Record<string, unknown>[], opts?: { maxRows?: number; maxChars?: number }): string {
	const maxRows = clampInt(opts?.maxRows ?? 50, 1, 200)
	const maxChars = clampInt(opts?.maxChars ?? 12_000, 1000, 200_000)

	const lines: string[] = []
	const push = (s: string) => {
		if (lines.length >= maxRows) return
		lines.push(s)
	}

	if (signal === 'logs') {
		for (const r of rows) {
			const ts = fmtTs(pickNum(r, 'ts_ms'))
			const level = pickStr(r, 'level')
			const msg = pickStr(r, 'body_text') || pickStr(r, 'body_json')
			const traceId = pickStr(r, 'trace_id')
			const spanId = pickStr(r, 'span_id')
			push(`${ts} ${level} ${msg}${traceId ? ` (trace=${traceId}${spanId ? ` span=${spanId}` : ''})` : ''}`)
		}
	} else if (signal === 'traces') {
		for (const r of rows) {
			const ts = fmtTs(pickNum(r, 'start_ts_ms'))
			const status = pickStr(r, 'status')
			const name = pickStr(r, 'name')
			const dur = pickNum(r, 'duration_ms')
			const traceId = pickStr(r, 'trace_id')
			const spanId = pickStr(r, 'span_id')
			push(`${ts} ${status || 'ok'} ${name} (${dur}ms)${traceId ? ` (trace=${traceId}${spanId ? ` span=${spanId}` : ''})` : ''}`)
		}
	} else {
		for (const r of rows) {
			const ts = fmtTs(pickNum(r, 'ts_ms'))
			const type = pickStr(r, 'type')
			const name = pickStr(r, 'name')
			const value = pickStr(r, 'value')
			push(`${ts} ${type} ${name} = ${value}`)
		}
	}

	let text = lines.join('\n')
	if (text.length > maxChars) text = text.slice(0, Math.max(0, maxChars - 10)) + '\n…(truncated)'
	return text
}

function createOtlpViewerMcpServer(getStore: () => OtlpViewerDuckDbStore | null) {
	const server = new McpServer({
		name: 'otlp-viewer',
		version: 'dev',
		// biome-ignore lint/suspicious/noExplicitAny: schema adapter surface is intentionally flexible.
		schemaAdapter: (schema) => toJsonSchema(schema as any) as Record<string, unknown>,
	})

	server.tool('otlpViewer.storeStats', {
		description: 'Read OTLP viewer store stats (DuckDB path, pending/dropped rows).',
		inputSchema: v.object({}),
		outputSchema: StoreStatsSchema,
		handler: () => {
			const store = getStore()
			const out: OtlpViewerStoreStats = store
				? store.stats()
				: { enabled: false, dbPath: ':memory:', pending: { logs: 0, spans: 0, metrics: 0 }, dropped: { logs: 0, spans: 0, metrics: 0 } }
			return textResult(out.enabled ? `otlp-viewer: ${out.dbPath}` : 'otlp-viewer disabled', out)
		},
	})

	server.tool('otlpViewer.list', {
		description: 'List logs/spans/metrics rows (structured filters only; safe params).',
		inputSchema: v.object({ signal: SignalSchema, opts: ListOptionsSchema }),
		outputSchema: ListOutputSchema,
		handler: async (args) => {
			const store = getStore()
			if (!store) return textResult('otlp-viewer disabled', { total: 0, rows: [] })
			const out = await store.list(args.signal as OtlpSignal, args.opts)
			return textResult(`otlp ${args.signal}: ${out.rows.length} rows (total=${out.total})`, out)
		},
	})

	server.tool('otlpViewer.listText', {
		description: 'List rows and return an LLM-friendly compact text rendering (recommended).',
		inputSchema: v.object({
			signal: SignalSchema,
			opts: ListOptionsSchema,
			format: v.optional(v.object({ maxRows: v.optional(v.number()), maxChars: v.optional(v.number()) })),
		}),
		outputSchema: ListTextOutputSchema,
		handler: async (args) => {
			const store = getStore()
			if (!store) return textResult('otlp-viewer disabled', { text: '', total: 0, shown: 0, rows: [] })
			const out = await store.list(args.signal as OtlpSignal, args.opts)
			const shownRows = out.rows.slice(0, clampInt(args.format?.maxRows ?? out.rows.length, 1, 200))
			const text = rowsToText(args.signal as OtlpSignal, shownRows, { maxRows: args.format?.maxRows, maxChars: args.format?.maxChars })
			return textResult(text || `otlp ${args.signal}: 0 rows`, { text, total: out.total, shown: shownRows.length, rows: shownRows })
		},
	})

	server.tool('otlpViewer.listTraces', {
		description: 'List trace summaries (grouped by trace_id).',
		inputSchema: v.object({ opts: ListOptionsSchema }),
		outputSchema: ListTracesOutputSchema,
		handler: async (args) => {
			const store = getStore()
			if (!store) return textResult('otlp-viewer disabled', { total: 0, rows: [] })
			const out = await store.listTraces(args.opts)
			return textResult(`traces: ${out.rows.length} rows (total=${out.total})`, out as { total: number; rows: OtlpViewerTraceSummaryRow[] })
		},
	})

	server.tool('otlpViewer.getTrace', {
		description: 'Get a trace detail (span list ordered by time).',
		inputSchema: v.object({ traceId: v.string() }),
		outputSchema: TraceDetailSchema,
		handler: async (args) => {
			const store = getStore()
			if (!store) {
				const out: OtlpViewerTraceDetail = { traceId: '', startTsMs: 0, endTsMs: 0, durationMs: 0, spans: 0, errors: 0, rows: [] }
				return textResult('otlp-viewer disabled', out)
			}
			const out = await store.getTrace(args.traceId)
			return textResult(`trace ${out.traceId}: ${out.spans} spans (errors=${out.errors})`, out)
		},
	})

	server.tool('otlpViewer.facetKeys', {
		description: 'List popular attribute keys within the filtered result set (approx; scans newest rows).',
		inputSchema: v.object({
			signal: SignalSchema,
			opts: ListOptionsSchema,
			limits: v.optional(v.object({ scanRows: v.optional(v.number()), limitKeys: v.optional(v.number()) })),
		}),
		outputSchema: FacetKeysOutputSchema,
		handler: async (args) => {
			const store = getStore()
			if (!store) return textResult('otlp-viewer disabled', { keys: [] })
			const out = await store.facetKeys(args.signal as OtlpSignal, args.opts, args.limits)
			return textResult(`facetKeys: ${out.keys.length} keys`, out)
		},
	})

	server.tool('otlpViewer.facetValues', {
		description: 'List popular values for a given attribute key within the filtered result set (approx; scans newest rows).',
		inputSchema: v.object({
			signal: SignalSchema,
			key: v.string(),
			opts: ListOptionsSchema,
			limits: v.optional(v.object({ scanRows: v.optional(v.number()), limitValues: v.optional(v.number()) })),
		}),
		outputSchema: FacetValuesOutputSchema,
		handler: async (args) => {
			const store = getStore()
			if (!store) return textResult('otlp-viewer disabled', { key: String(args.key ?? ''), values: [] })
			const out = await store.facetValues(args.signal as OtlpSignal, args.key, args.opts, args.limits)
			return textResult(`facetValues(${out.key}): ${out.values.length} values`, out)
		},
	})

	server.tool('otlpViewer.query', {
		description: 'Run DuckDB SQL against otlp_logs/otlp_spans/otlp_metrics (dev-only; be careful with large queries).',
		inputSchema: QueryInputSchema,
		outputSchema: QueryOutputSchema,
		handler: async (args) => {
			const store = getStore()
			if (!store) {
				const out: OtlpViewerQueryResult = { columns: [], rows: [] }
				return textResult('otlp-viewer disabled', out)
			}
			const out = await store.query(args.sql, args.params as any)
			return textResult(`query: ${out.rows.length} rows`, out)
		},
	})

	server.tool('otlpViewer.errorsText', {
		description: 'Summarize recent errors from OTLP logs (level=error) and spans (status=error) as compact text.',
		inputSchema: v.object({
			sinceTsMs: v.optional(v.number()),
			limit: v.optional(v.number()),
			q: v.optional(v.string()),
			filters: v.optional(v.array(FieldFilterSchema)),
		}),
		outputSchema: v.object({
			text: v.string(),
			logs: v.object({ total: v.number(), rows: v.array(v.record(v.string(), v.unknown())) }),
			spans: v.object({ total: v.number(), rows: v.array(v.record(v.string(), v.unknown())) }),
		}),
		handler: async (args) => {
			const store = getStore()
			if (!store) return textResult('otlp-viewer disabled', { text: '', logs: { total: 0, rows: [] }, spans: { total: 0, rows: [] } })

			const limit = clampInt(args.limit ?? 30, 1, 200)
			const fromTsMs = Number.isFinite(Number(args.sinceTsMs)) ? Number(args.sinceTsMs) : Date.now() - 15 * 60_000
			const filters = args.filters?.length ? (args.filters as OtlpViewerFieldFilter[]) : undefined

			const logs = await store.list('logs', { q: args.q, fromTsMs, level: 'error', limit, filters } as OtlpViewerListOptions)
			const spans = await store.list('traces', { q: args.q, fromTsMs, status: 'error', limit, filters } as OtlpViewerListOptions)

			const textParts = [
				`logs(error): shown=${logs.rows.length} total=${logs.total}`,
				rowsToText('logs', logs.rows, { maxRows: Math.min(30, limit), maxChars: 8000 }),
				'',
				`spans(error): shown=${spans.rows.length} total=${spans.total}`,
				rowsToText('traces', spans.rows, { maxRows: Math.min(30, limit), maxChars: 8000 }),
			]
			const text = textParts.filter(Boolean).join('\n')
			return textResult(text, { text, logs, spans })
		},
	})

	return server
}

export function registerOtlpViewerMcpHttp(
	ctx: Context,
	getStore: () => OtlpViewerDuckDbStore | null,
	cfg?: { basePath?: string; maxEventBufferSize?: number },
): () => void {
	const basePathRaw = String(cfg?.basePath ?? '/api/otlp-viewer/mcp').trim() || '/api/otlp-viewer/mcp'
	const basePath = basePathRaw.startsWith('/') ? basePathRaw : `/${basePathRaw}`

	const server = createOtlpViewerMcpServer(getStore)
	const transport = new StreamableHttpTransport({
		sessionAdapter: new InMemorySessionAdapter({ maxEventBufferSize: clampInt(cfg?.maxEventBufferSize ?? 1024, 64, 10_000) }),
	})
	const handler = transport.bind(server)

	return ctx.honoService.modifyApp((app) => {
		const forward = async (c: any) => await handler((c.req.raw as Request) ?? (c.req as Request))
		app.all(basePath, forward)
		app.all(`${basePath}/*`, forward)
	})
}
