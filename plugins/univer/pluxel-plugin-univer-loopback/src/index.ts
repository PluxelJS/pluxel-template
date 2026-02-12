import { BasePlugin, Plugin } from '@pluxel/hmr'
import { RpcTarget } from '@pluxel/hmr/capnweb'
import type { UniverLoopbackRunInput, UniverLoopbackRunResult } from '@pluxel/univer-headless/protocol'
import { createHeadlessUniverEngine, createUniverAiBridge, runUniverAxLoopback, spanError, spanOk, type UniverAxOtel } from '@pluxel/univer-headless'
import { createAxAIFromConnection } from 'pluxel-plugin-llm-hub/adapters/ax'
import { LLM } from 'pluxel-plugin-llm-hub'
import { createOtlpOtelMeter, createOtlpOtelTracer } from 'pluxel-plugin-otlp/otel'
import UniverWorkbooksPlugin from 'pluxel-plugin-univer-workbooks'
import { registerUniverLoopbackHttp } from './loopback.http'
import { Otlp } from 'pluxel-plugin-otlp'

function normalizeText(input: unknown) {
	const t = String(input ?? '').trim()
	return t
}

function makeRunId() {
	try {
		const c = globalThis.crypto
		if (c && typeof c.randomUUID === 'function') return String(c.randomUUID())
	} catch {}
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function truncateText(input: unknown, maxChars: number) {
	const s = String(input ?? '')
	if (s.length <= maxChars) return s
	return `${s.slice(0, Math.max(0, maxChars - 1))}…`
}

function safeUrlForAttr(input: string): string {
	try {
		const u = new URL(input)
		// Strip query/fragment for safety.
		return `${u.origin}${u.pathname}`
	} catch {
		return input
	}
}

function wrapFetchWithOtel(baseFetch: typeof fetch, otel: UniverAxOtel): typeof fetch {
	const tracer = otel.tracer
	if (!tracer) return baseFetch
	return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
		const url = safeUrlForAttr(rawUrl)
		const method = (init?.method ?? (input instanceof Request ? input.method : undefined) ?? 'GET').toString().toUpperCase()

		return await tracer.startActiveSpan(
			'llm.fetch',
			{
				attributes: {
					...(otel.attributes ?? {}),
					'http.request.method': method,
					'url.full': url,
				},
			},
			async (span) => {
				const t0 = Date.now()
				try {
					const res = await baseFetch(input, init)
					const ms = Date.now() - t0
					span.setAttribute('http.response.status_code', res.status)
					span.setAttribute('http.response.duration_ms', ms)
					if (res.status >= 400) span.setStatus({ code: 2, message: `HTTP ${res.status}` })
					else spanOk(span)
					return res
				} catch (error) {
					spanError(span, error)
					throw error
				} finally {
					span.end()
				}
			},
		)
	}) as typeof fetch
}

function isConflictCommitResult(input: unknown): input is Readonly<{
	conflict: true
	currentRev: number
	latestSnapshotUrl: string | null
	latestEtag: string | null
}> {
	if (!input || typeof input !== 'object') return false
	const r = input as Record<string, unknown>
	return (
		r.conflict === true &&
		typeof r.currentRev === 'number' &&
		(typeof r.latestSnapshotUrl === 'string' || r.latestSnapshotUrl === null) &&
		(typeof r.latestEtag === 'string' || r.latestEtag === null)
	)
}

function conflictResult(input: { currentRev: number; latestSnapshotUrl: string | null; latestEtag: string | null }): UniverLoopbackRunResult {
	return {
		ok: false,
		error: 'conflict',
		conflict: {
			currentRev: input.currentRev,
			snapshotUrl: input.latestSnapshotUrl,
			etag: input.latestEtag,
		},
	}
}

export class UniverLoopbackRpc extends RpcTarget {
	constructor(private readonly plugin: UniverLoopbackPlugin) {
		super()
	}

	runLoopback(input: UniverLoopbackRunInput): Promise<UniverLoopbackRunResult> {
		return this.plugin.runLoopback(input)
	}
}

@Plugin({ name: 'UniverLoopback', type: 'service' })
export class UniverLoopbackPlugin extends BasePlugin {
	private readonly engine = createHeadlessUniverEngine()
	private seq: Promise<unknown> = Promise.resolve()

	constructor(
		private readonly llm: LLM,
		private readonly otlp: Otlp,
		private readonly workbooks: UniverWorkbooksPlugin,
	) {
		super()
	}

	override async init(): Promise<void> {
		this.ctx.effects.defer(() => this.engine.dispose())
		this.registerHttp()
		this.registerRpc()
	}

	private registerHttp() {
		try {
			const off = registerUniverLoopbackHttp(this.ctx, (input) => this.runLoopback(input))
			this.ctx.effects.defer(off)
		} catch (error) {
			const tracer = createOtlpOtelTracer(this.otlp, { tracerName: 'univer.loopback' })
			tracer.startActiveSpan('univer.loopback.init', { attributes: { 'univer.init.part': 'http' } }, (span) => {
				try {
					spanError(span, error)
				} finally {
					span.end()
				}
			})
		}
	}

	private registerRpc() {
		try {
			this.ctx.ext.rpc.registerExtension(() => new UniverLoopbackRpc(this))
		} catch (error) {
			const tracer = createOtlpOtelTracer(this.otlp, { tracerName: 'univer.loopback' })
			tracer.startActiveSpan('univer.loopback.init', { attributes: { 'univer.init.part': 'rpc' } }, (span) => {
				try {
					spanError(span, error)
				} finally {
					span.end()
				}
			})
		}
	}

	async runLoopback(input: UniverLoopbackRunInput): Promise<UniverLoopbackRunResult> {
		// Headless Univer instance is shared; serialize loopback runs for safety.
		const run = async () => this.runLoopbackInner(input)
		const p = this.seq.then(run, run)
		this.seq = p.then(() => undefined, () => undefined)
		return p
	}

	private async runLoopbackInner(input: UniverLoopbackRunInput): Promise<UniverLoopbackRunResult> {
		const runId = makeRunId()
		const workbookId = normalizeText(input?.workbookId)
		if (!workbookId) return { ok: false, runId, error: '[univer] workbookId required' }

		const instruction = normalizeText(input?.instruction)
		if (!instruction) return { ok: false, runId, error: '[univer] instruction must be non-empty' }

		const tracer = createOtlpOtelTracer(this.otlp, { tracerName: 'univer.loopback' })
		const meter = createOtlpOtelMeter(this.otlp, { meterName: 'univer.loopback' })
		const otel: UniverAxOtel = {
			tracer,
			meter,
			attributes: {
				'univer.run_id': runId,
				'univer.workbook_id': workbookId,
				'univer.base_rev': typeof input.baseRev === 'number' ? input.baseRev : -1,
				'univer.mode': 'safe',
				'univer.llm_profile_id': String(input.llmProfileId ?? ''),
				'univer.instruction.preview': truncateText(instruction, 512),
			},
		}

		const store = this.workbooks.requireStore()
			return await tracer.startActiveSpan(
				'univer.loopback.request',
				{
					attributes: {
						...(otel.attributes ?? {}),
						'univer.scopes.read.count': input.scopes.read?.length ?? 0,
						'univer.scopes.write.count': input.scopes.write?.length ?? 0,
						'univer.scopes.current': String(input.scopes.current ?? ''),
					},
				},
				async (rootSpan): Promise<UniverLoopbackRunResult> => {
					const reqStart = Date.now()
					try {
						let meta
						try {
							meta = store.openWorkbook(workbookId)
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e)
						rootSpan.setStatus({ code: 2, message: msg })
						return { ok: false, runId, error: msg }
					}

					if (meta.latestRev <= 0) {
						const msg = '[univer] workbook not initialized yet (wait for initial save)'
						rootSpan.setStatus({ code: 2, message: msg })
						return { ok: false, runId, error: msg }
					}

					const baseRev =
						typeof input.baseRev === 'number' && Number.isFinite(input.baseRev) ? input.baseRev : meta.latestRev
					if (baseRev !== meta.latestRev) {
						rootSpan.setAttribute('univer.conflict', true)
						return {
							...conflictResult({ currentRev: meta.latestRev, latestSnapshotUrl: meta.latestSnapshotUrl, latestEtag: meta.latestEtag }),
							runId,
						}
					}

					const snap = store.getSnapshot(workbookId, baseRev)
					if (!snap) {
						const msg = `[univer] snapshot not found: ${workbookId}@${baseRev}`
						rootSpan.setStatus({ code: 2, message: msg })
						return { ok: false, runId, error: msg }
					}

					let snapshot: unknown
					try {
						snapshot = JSON.parse(snap.json)
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e)
						rootSpan.setStatus({ code: 2, message: msg })
						return { ok: false, runId, error: `[univer] invalid snapshot json: ${msg}` }
					}

					let conn
					try {
						conn = await tracer.startActiveSpan(
							'univer.llm.connection',
							{ attributes: { ...(otel.attributes ?? {}) } },
							(span) =>
								this.llm
									.connection(
										input.llmProfileId
											? { profileId: input.llmProfileId, traceId: runId, sessionId: workbookId }
											: { traceId: runId, sessionId: workbookId },
									)
									.finally(() => span.end()),
						)
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e)
						rootSpan.setStatus({ code: 2, message: msg })
						return { ok: false, runId, error: msg }
					}

					const provider = String(conn.profile.provider ?? '')
					const model = String(conn.profile.model ?? '')
					rootSpan.setAttribute('llm.provider', provider)
					rootSpan.setAttribute('llm.model', model)

					const otelConn = {
						...conn,
						fetch: wrapFetchWithOtel(conn.fetch, otel),
						profile: {
							...conn.profile,
							options: { ...(conn.profile.options ?? {}), tracer, meter },
						},
					}
					const ai = createAxAIFromConnection(otelConn)

					const loopRes = await tracer.startActiveSpan(
						'univer.headless.loopback',
						{ attributes: { ...(otel.attributes ?? {}) } },
						async (span) => {
							try {
								const t0 = Date.now()
								const out = await this.engine.withWorkbook(snapshot, async (workbook) => {
									const bridge = createUniverAiBridge(workbook)
									const res = await runUniverAxLoopback(
										ai,
										bridge,
										{
											instruction,
											scopes: input.scopes,
											contexts: input.contexts,
										},
										{ otel },
									)

									if (!res.ok) return { ok: false as const, error: res.error, rounds: res.rounds, stats: res.stats }

									const saveFn = workbook?.save
									if (typeof saveFn !== 'function') throw new Error('[univer] workbook.save() missing')
									const nextSnapshot = saveFn.call(workbook)
									const nextJson = JSON.stringify(nextSnapshot)
									if (!nextJson) throw new Error('[univer] empty snapshot json after loopback')

									return { ok: true as const, nextJson, rounds: res.rounds, stats: res.stats, summary: res.summary, ms: Date.now() - t0 }
								})
								spanOk(span)
								return out
							} catch (error) {
								spanError(span, error)
								throw error
							} finally {
								span.end()
							}
						},
					)

					if (!loopRes.ok) {
						rootSpan.setStatus({ code: 2, message: loopRes.error })
						return { ok: false, runId, error: loopRes.error }
					}

					const nextJson = loopRes.nextJson
					const rounds = loopRes.rounds
					const appliedOps = loopRes.stats.appliedOps + loopRes.stats.appliedClears
					rootSpan.setAttribute('univer.rounds', rounds)
					rootSpan.setAttribute('univer.applied_ops', appliedOps)

					if (nextJson === snap.json) {
						// No change: keep the current snapshot pointers.
						spanOk(rootSpan)
						return {
							ok: true,
							runId,
							baseRev,
							newRev: baseRev,
							snapshotUrl: store.snapshotUrl(workbookId, baseRev),
							etag: snap.etag,
							rounds,
							appliedOps,
							summary: loopRes.summary,
						}
					}

					const committed = store.commitSnapshot({ id: workbookId, baseRev, json: nextJson })
					if (isConflictCommitResult(committed)) {
						rootSpan.setAttribute('univer.conflict', true)
						return {
							...conflictResult({
								currentRev: committed.currentRev,
								latestSnapshotUrl: committed.latestSnapshotUrl,
								latestEtag: committed.latestEtag,
							}),
							runId,
						}
					}

					spanOk(rootSpan)
					return {
						ok: true,
						runId,
						baseRev,
						newRev: committed.newRev,
						snapshotUrl: committed.newSnapshotUrl,
						etag: committed.newEtag,
						rounds,
						appliedOps,
						summary: loopRes.summary,
					}
				} catch (error) {
					spanError(rootSpan, error)
					const msg = error instanceof Error ? error.message : String(error)
					return { ok: false, runId, error: msg }
				} finally {
					rootSpan.setAttribute('univer.request.duration_ms', Date.now() - reqStart)
					rootSpan.end()
				}
			},
		)
	}
}

export default UniverLoopbackPlugin

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			UniverLoopback: UniverLoopbackRpc
		}
	}
}
