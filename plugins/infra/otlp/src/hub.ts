import type { Context } from '@pluxel/hmr'
import { Plugin } from '@pluxel/hmr'

import type {
	OtlpAttributes,
	OtlpLogRecordInput,
	OtlpMetricPointInput,
	OtlpSignal,
	OtlpSignalStats,
	OtlpSpanHandle,
	OtlpSpanInput,
	OtlpSpanStatus,
	OtlpStats,
} from './core.js'
import { Otlp } from './core.js'
import type { OtlpTap } from './tap.js'

import {
	DEFAULT_BATCH,
	DEFAULT_PUSH,
	DEFAULT_QUEUE,
	DEFAULT_RESOURCE,
	DEFAULT_ROUTING,
	DEFAULT_SCOPE,
	DEFAULT_SIGNALS,
	OtlpHubBatchCfgSchema,
	OtlpHubExportingCfgSchema,
	normalizeEndpoint,
	OtlpHubQueueCfgSchema,
	OtlpHubResourceCfgSchema,
	OtlpHubRoutingCfgSchemaV2,
	OtlpHubScopeCfgSchema,
	OtlpHubSignalsCfgSchema,
	type OtlpHubBatchConfig,
	type OtlpHubExportingConfig,
	type OtlpHubPushConfig,
	type OtlpHubQueueConfig,
	type OtlpHubResourceConfig,
	type OtlpHubRoutingConfig,
	type OtlpHubRoutingConfigV2,
	type OtlpHubScopeConfig,
	type OtlpHubSignalsConfig,
	type OtlpHubTargetConfig,
} from './config.js'
import { logRecordToItem, metricPointToItem, spanToItem, toKeyValues } from './encode.js'
import { randomHex } from './id.js'
import { OtlpHttpJsonQueue } from './queue.js'

type DestinationState = {
	endpoints: Record<OtlpSignal, string>
	headers: Record<string, string>
	timeoutMs: number
	logsQ: OtlpHttpJsonQueue
	tracesQ: OtlpHttpJsonQueue
	metricsQ: OtlpHttpJsonQueue
}

@Plugin(Otlp, { name: 'OtlpHub', type: 'service' })
export class OtlpHub extends Otlp {
	private exporting: OtlpHubExportingConfig = this.configs.use(OtlpHubExportingCfgSchema)
	private signals: OtlpHubSignalsConfig = this.configs.use(OtlpHubSignalsCfgSchema)
	private routing: OtlpHubRoutingConfigV2 = this.configs.use(OtlpHubRoutingCfgSchemaV2)
	private resource: OtlpHubResourceConfig = this.configs.use(OtlpHubResourceCfgSchema)
	private scope: OtlpHubScopeConfig = this.configs.use(OtlpHubScopeCfgSchema)
	private batch: OtlpHubBatchConfig = this.configs.use(OtlpHubBatchCfgSchema)
	private queue: OtlpHubQueueConfig = this.configs.use(OtlpHubQueueCfgSchema)

	private cfg!: {
		enabled: boolean
		push: OtlpHubPushConfig
		signals: OtlpHubSignalsConfig
		targets: OtlpHubTargetConfig[]
		routing: OtlpHubRoutingConfig
		resource: OtlpHubResourceConfig
		scope: OtlpHubScopeConfig
		batch: OtlpHubBatchConfig
		queue: OtlpHubQueueConfig
	}

	private readonly defaultTargetId = 'default'
	private warnedUnknownTargets = new Set<string>()

	private baseAttrs: OtlpAttributes = {}
	private resourceAttrs: OtlpAttributes = {}
	private scopeInfo: { name: string; version?: string } = { name: '' }

	private prefix: Record<OtlpSignal, string> = { logs: '', traces: '', metrics: '' }
	private suffix: Record<OtlpSignal, string> = { logs: '', traces: '', metrics: '' }

	private destinations: Record<string, DestinationState> = {}
	private readonly taps = new Set<OtlpTap>()

	registerTap(tap: OtlpTap): () => void {
		this.taps.add(tap)
		return () => this.taps.delete(tap)
	}

	override async init(_abort: AbortSignal): Promise<void> {
		this.ctx.effects.defer(() => {
			this.clearDestinationTimers()
		})

		const exportingMode = this.exporting?.mode ?? 'tap'
		const pushCfg: OtlpHubPushConfig = (this.exporting?.push ?? DEFAULT_PUSH) as any

		const routingMode = this.routing?.mode ?? 'single'
		const routingTargets: OtlpHubTargetConfig[] = routingMode === 'multi' ? (this.routing?.targets ?? []) : []
		const routingMap = routingMode === 'multi' ? ((this.routing?.routing ?? DEFAULT_ROUTING) as any) : (DEFAULT_ROUTING as any)

		this.cfg = {
			enabled: exportingMode === 'push',
			push: pushCfg,
			signals: (this.signals ?? DEFAULT_SIGNALS) as any,
			targets: routingTargets,
			routing: routingMap,
			resource: (this.resource ?? DEFAULT_RESOURCE) as any,
			scope: (this.scope ?? DEFAULT_SCOPE) as any,
			batch: (this.batch ?? DEFAULT_BATCH) as any,
			queue: (this.queue ?? DEFAULT_QUEUE) as any,
		}

		this.baseAttrs = {
			'pluxel.provider.id': this.ctx.pluginInfo.id,
			'pluxel.provider.name': this.ctx.pluginInfo.displayName,
		}

		const resourceAttrs: OtlpAttributes = {
			'service.name': this.cfg.resource.serviceName,
			...(this.cfg.resource.serviceNamespace ? { 'service.namespace': this.cfg.resource.serviceNamespace } : {}),
			...(this.cfg.resource.serviceVersion ? { 'service.version': this.cfg.resource.serviceVersion } : {}),
			...(this.cfg.resource.resourceAttributes ?? {}),
		}

		this.resourceAttrs = { ...resourceAttrs }

		const resource = { attributes: toKeyValues(resourceAttrs) }
		const scope = {
			name: this.cfg.scope.name,
			...(this.cfg.scope.version ? { version: this.cfg.scope.version } : {}),
		}
		this.scopeInfo = { name: scope.name, ...(scope.version ? { version: scope.version } : {}) }

		const resourceJson = JSON.stringify(resource)
		const scopeJson = JSON.stringify(scope)

		this.prefix.logs = `{"resourceLogs":[{"resource":${resourceJson},"scopeLogs":[{"scope":${scopeJson},"logRecords":[`
		this.suffix.logs = `]}]}]}`

		this.prefix.traces = `{"resourceSpans":[{"resource":${resourceJson},"scopeSpans":[{"scope":${scopeJson},"spans":[`
		this.suffix.traces = `]}]}]}`

		this.prefix.metrics = `{"resourceMetrics":[{"resource":${resourceJson},"scopeMetrics":[{"scope":${scopeJson},"metrics":[`
		this.suffix.metrics = `]}]}]}`

		this.buildExporters({ enabled: this.cfg.enabled })

		if (!this.cfg.enabled) {
			this.ctx.logger.info('OtlpHub initialized (export disabled)', {
				exporting: { mode: exportingMode },
				signals: this.cfg.signals,
				routing: { mode: routingMode },
			})
			return
		}

		this.ctx.logger.info('OtlpHub initialized', {
			exporting: { mode: exportingMode },
			endpoint: normalizeEndpoint(this.cfg.push.endpoint),
			routing: { mode: routingMode },
			targets: this.cfg.targets.map((t) => t.id).filter(Boolean),
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
		const push = this.cfg?.push ?? (DEFAULT_PUSH as any)
		const batch = this.cfg?.batch ?? DEFAULT_BATCH
		const queue = this.cfg?.queue ?? DEFAULT_QUEUE

		const pushEndpoint = normalizeEndpoint(String((push as any)?.endpoint ?? DEFAULT_PUSH.endpoint))
		const endpointsRaw = ((push as any)?.endpoints ?? {}) as Partial<Record<OtlpSignal, string>>
		const pushTimeoutMs = Math.max(1, Math.floor((push as any)?.timeoutMs ?? DEFAULT_PUSH.timeoutMs))

		const mkSend =
			(dest: { endpoints: Record<OtlpSignal, string>; headers: Record<string, string> }, signal: OtlpSignal, path: '/v1/logs' | '/v1/traces' | '/v1/metrics') =>
			async (body: string, tMs: number) => {
				if (!enabled) return
				const url = `${dest.endpoints[signal]}${path}`
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

		const mkQueue = (
			dest: { endpoints: Record<OtlpSignal, string>; headers: Record<string, string>; timeoutMs: number },
			signal: OtlpSignal,
			path: '/v1/logs' | '/v1/traces' | '/v1/metrics',
		) =>
			new OtlpHttpJsonQueue({
				signal,
				enabled: enabled && !!this.cfg?.enabled && !!this.cfg?.signals?.[signal],
				batch,
				queueCfg: queue,
				timeoutMs: dest.timeoutMs,
				buildBody: (items) => `${this.prefix[signal]}${items.map((i) => i.json).join(',')}${this.suffix[signal]}`,
				sendRequest: mkSend(dest, signal, path),
				warn: (message, meta) => this.ctx.logger.warn(message, meta),
			})

		const dests: Record<string, DestinationState> = {}
		const addDestination = (
			id: string,
			endpointBase: string,
			perSignalBases: Partial<Record<OtlpSignal, string>>,
			headers: Record<string, string>,
			timeoutMs: number,
		) => {
			const endpoint = normalizeEndpoint(endpointBase)
			const endpoints: Record<OtlpSignal, string> = {
				logs: normalizeEndpoint(perSignalBases.logs?.trim() ? perSignalBases.logs : endpoint),
				traces: normalizeEndpoint(perSignalBases.traces?.trim() ? perSignalBases.traces : endpoint),
				metrics: normalizeEndpoint(perSignalBases.metrics?.trim() ? perSignalBases.metrics : endpoint),
			}
			const dest = { endpoints, headers, timeoutMs }
			dests[id] = {
				endpoints,
				headers,
				timeoutMs,
				logsQ: mkQueue(dest, 'logs', '/v1/logs'),
				tracesQ: mkQueue(dest, 'traces', '/v1/traces'),
				metricsQ: mkQueue(dest, 'metrics', '/v1/metrics'),
			}
		}

		addDestination(this.defaultTargetId, pushEndpoint, endpointsRaw, { ...(push as any)?.headers }, pushTimeoutMs)

		for (const t of this.cfg?.targets ?? []) {
			const id = String((t as any)?.id ?? '').trim()
			if (!id || id === this.defaultTargetId) continue
			const targetEndpoint = String((t as any)?.endpoint ?? pushEndpoint)
			addDestination(
				id,
				targetEndpoint,
				(t as any)?.endpoints ?? {},
				{ ...((push as any)?.headers ?? {}), ...((t as any)?.headers ?? {}) },
				Math.max(1, Math.floor((t as any)?.timeoutMs ?? pushTimeoutMs)),
			)
		}

		this.destinations = dests
	}

	private callerMeta(): { attrs: OtlpAttributes; callerId: string; callerName: string; resourceAttrs: OtlpAttributes; scope: { name: string; version?: string } } {
		const caller = this.callerOrSelf() as unknown as Context
		const callerId = String((caller as any)?.pluginInfo?.id ?? '').trim()
		const callerName = String((caller as any)?.pluginInfo?.displayName ?? '').trim()
		const callerAttrs: OtlpAttributes = {
			...(callerId ? { 'pluxel.caller.id': callerId } : {}),
			...(callerName ? { 'pluxel.caller.name': callerName } : {}),
		}
		return { attrs: { ...this.baseAttrs, ...callerAttrs }, callerId, callerName, resourceAttrs: this.resourceAttrs, scope: this.scopeInfo }
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
			enabled: !!this.cfg?.enabled,
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
			if (!this.cfg?.signals?.logs) return
			const caller = this.callerMeta()
			const list = Array.isArray(input) ? input : [input]
			for (const tap of this.taps) {
				try {
					tap.onLogs?.(list, caller)
			} catch {
				// ignore
			}
		}

			if (!this.cfg?.enabled) return
			const dest = this.resolveDestination(caller.callerId, caller.callerName)
			if (!dest) return
			const q = dest.logsQ
			const baseAttrs = caller.attrs
		for (const item of list) await q.enqueue(logRecordToItem(item, baseAttrs))
	}

		override logSync(input: OtlpLogRecordInput | readonly OtlpLogRecordInput[]): void {
			if (!this.cfg?.signals?.logs) return
			const caller = this.callerMeta()
			const list = Array.isArray(input) ? input : [input]
			for (const tap of this.taps) {
				try {
					tap.onLogs?.(list, caller)
			} catch {
				// ignore
			}
		}

			if (!this.cfg?.enabled) return
			const dest = this.resolveDestination(caller.callerId, caller.callerName)
			if (!dest) return
			const q = dest.logsQ
			const baseAttrs = caller.attrs
		for (const item of list) q.tryEnqueue(logRecordToItem(item, baseAttrs))
	}

		override async trace(input: OtlpSpanInput | readonly OtlpSpanInput[]): Promise<void> {
			if (!this.cfg?.signals?.traces) return
			const caller = this.callerMeta()
			const raw = Array.isArray(input) ? input : [input]
			const list = raw.map((s) => this.normalizeSpan(s))
			for (const tap of this.taps) {
			try {
				tap.onTraces?.(list, caller)
			} catch {
				// ignore
			}
		}

			if (!this.cfg?.enabled) return
			const dest = this.resolveDestination(caller.callerId, caller.callerName)
			if (!dest) return
			const q = dest.tracesQ
			const baseAttrs = caller.attrs
		for (const item of list) await q.enqueue(spanToItem(item, baseAttrs))
	}

		override traceSync(input: OtlpSpanInput | readonly OtlpSpanInput[]): void {
			if (!this.cfg?.signals?.traces) return
			const caller = this.callerMeta()
			const raw = Array.isArray(input) ? input : [input]
			const list = raw.map((s) => this.normalizeSpan(s))
			for (const tap of this.taps) {
			try {
				tap.onTraces?.(list, caller)
			} catch {
				// ignore
			}
		}

			if (!this.cfg?.enabled) return
			const dest = this.resolveDestination(caller.callerId, caller.callerName)
			if (!dest) return
			const q = dest.tracesQ
			const baseAttrs = caller.attrs
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

			const tracesEnabled = !!this.cfg?.signals?.traces && (!!this.cfg?.enabled || this.taps.size > 0)
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
			if (!this.cfg?.signals?.metrics) return
			const caller = this.callerMeta()
			const list = Array.isArray(input) ? input : [input]
			for (const tap of this.taps) {
				try {
					tap.onMetrics?.(list, caller)
			} catch {
				// ignore
			}
		}

			if (!this.cfg?.enabled) return
			const dest = this.resolveDestination(caller.callerId, caller.callerName)
			if (!dest) return
			const q = dest.metricsQ
			const baseAttrs = caller.attrs
		for (const item of list) await q.enqueue(metricPointToItem(item, baseAttrs))
	}

		override metricSync(input: OtlpMetricPointInput | readonly OtlpMetricPointInput[]): void {
			if (!this.cfg?.signals?.metrics) return
			const caller = this.callerMeta()
			const list = Array.isArray(input) ? input : [input]
			for (const tap of this.taps) {
				try {
					tap.onMetrics?.(list, caller)
			} catch {
				// ignore
			}
		}

			if (!this.cfg?.enabled) return
			const dest = this.resolveDestination(caller.callerId, caller.callerName)
			if (!dest) return
			const q = dest.metricsQ
			const baseAttrs = caller.attrs
		for (const item of list) q.tryEnqueue(metricPointToItem(item, baseAttrs))
	}

	override async flush(): Promise<void> {
		for (const d of Object.values(this.destinations)) {
			await d.logsQ.flush()
			await d.tracesQ.flush()
			await d.metricsQ.flush()
		}
	}

	private normalizeSpan(input: OtlpSpanInput): OtlpSpanInput {
		const traceId = String(input.traceId ?? '').trim() || randomHex(16)
		const spanId = String(input.spanId ?? '').trim() || randomHex(8)
		const startTsMs = typeof input.startTsMs === 'number' ? input.startTsMs : Date.now()
		const endTsMs = typeof input.endTsMs === 'number' ? input.endTsMs : startTsMs

		if (traceId === input.traceId && spanId === input.spanId && input.startTsMs === startTsMs && input.endTsMs === endTsMs) return input
		return {
			...input,
			traceId,
			spanId,
			startTsMs,
			endTsMs,
		}
	}
}
