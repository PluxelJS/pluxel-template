import { BasePlugin, Plugin } from '@pluxel/hmr'
import { RpcTarget } from '@pluxel/hmr/capnweb'
import type { UniverLoopbackRunInput, UniverLoopbackRunResult } from '@pluxel/univer-headless/protocol'
import { createHeadlessUniverEngine, createUniverAiBridge, runUniverAxLoopback } from '@pluxel/univer-headless'
import { createAxAIFromConnection } from 'pluxel-plugin-llm-hub/adapters/ax'
import { LLM } from 'pluxel-plugin-llm-hub'
import UniverWorkbooksPlugin from 'pluxel-plugin-univer-workbooks'
import { registerUniverLoopbackHttp } from './loopback.http'

function normalizeText(input: unknown) {
	const t = String(input ?? '').trim()
	return t
}

function makeRunId() {
	try {
		const c = (globalThis as any).crypto
		if (c && typeof c.randomUUID === 'function') return String(c.randomUUID())
	} catch {}
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function truncateText(input: unknown, maxChars: number) {
	const s = String(input ?? '')
	if (s.length <= maxChars) return s
	return `${s.slice(0, Math.max(0, maxChars - 1))}…`
}

type Logger = {
	debug?: (message: string, props?: Record<string, unknown>) => void
	info?: (message: string, props?: Record<string, unknown>) => void
	warn?: (message: string, props?: Record<string, unknown>) => void
}

function scopedLogger(base: Logger, baseProps: Record<string, unknown>): Logger {
	return {
		debug: (message, props) => base.debug?.(message, { ...baseProps, ...(props ?? {}) }),
		info: (message, props) => base.info?.(message, { ...baseProps, ...(props ?? {}) }),
		warn: (message, props) => base.warn?.(message, { ...baseProps, ...(props ?? {}) }),
	}
}

function redactHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [k, v] of headers.entries()) {
		const key = k.toLowerCase()
		if (key === 'authorization' || key === 'proxy-authorization' || key === 'x-api-key' || key === 'api-key') {
			out[k] = '[redacted]'
			continue
		}
		out[k] = v
	}
	return out
}

function wrapFetchWithLogging(baseFetch: typeof fetch, logger: Logger): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const t0 = Date.now()

		const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
		const method =
			(init?.method ?? (input instanceof Request ? input.method : undefined) ?? 'GET').toString().toUpperCase()

		let headers: Headers
		try {
			headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined) ?? undefined)
		} catch {
			headers = new Headers()
		}

		const body = (init as any)?.body
		const bodyPreview =
			typeof body === 'string'
				? truncateText(body, 1600)
				: body
					? `[${typeof body}]`
					: undefined

		const logFetch = logger.debug ?? logger.info
		logFetch?.('llm fetch request ({method}) {url}', {
			method,
			url,
			headers: redactHeaders(headers),
			...(typeof body === 'string' ? { bodyLength: body.length } : {}),
			...(bodyPreview ? { bodyPreview } : {}),
		})

		const res = await baseFetch(input as any, init as any)
		const ms = Date.now() - t0

		const contentType = res.headers.get('content-type') ?? ''
		const contentLengthHeader = res.headers.get('content-length')
		const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined

		let responsePreview: string | undefined
		try {
			// Best-effort: avoid pulling huge bodies into logs.
			const allowPreview =
				contentLength === undefined ? true : !Number.isFinite(contentLength) ? true : contentLength <= 200_000
			if (allowPreview) {
				const text = await res.clone().text()
				responsePreview = truncateText(text, 1600)
			}
		} catch {
			// ignore
		}

		logFetch?.('llm fetch response ({status}) ({ms}ms)', {
			status: res.status,
			ms,
			contentType,
			...(Number.isFinite(contentLength) ? { contentLength } : {}),
			...(responsePreview ? { responsePreview } : {}),
		})

		return res
	}) as typeof fetch
}

function isConflictCommitResult(input: unknown): input is Readonly<{
	conflict: true
	currentRev: number
	latestSnapshotUrl: string | null
	latestEtag: string | null
}> {
	return Boolean(input && typeof input === 'object' && (input as any).conflict === true)
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
			this.ctx.logger.warn('UniverLoopback HTTP routes registration skipped', { error })
		}
	}

	private registerRpc() {
		try {
			this.ctx.ext.rpc.registerExtension(() => new UniverLoopbackRpc(this))
		} catch (error) {
			this.ctx.logger.warn('UniverLoopback RPC registration skipped', { error })
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

		const log = scopedLogger(this.ctx.logger as any, { runId, workbookId })

		const instruction = normalizeText(input?.instruction)
		if (!instruction) return { ok: false, runId, error: '[univer] instruction must be non-empty' }

		log.info?.('UniverLoopback start ({workbookId})', {
			baseRev: input.baseRev,
			mode: input.mode,
			maxRounds: input.maxRounds,
			llmProfileId: input.llmProfileId,
			scopes: input.scopes,
			contextSelections: input.contexts?.selections?.length ?? 0,
			limits: input.limits,
			contract: input.contract,
			toolPolicy: input.toolPolicy,
			instructionPreview: truncateText(instruction, 800),
		})

		const store = this.workbooks.requireStore()
		let meta
		try {
			meta = store.openWorkbook(workbookId)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			return { ok: false, runId, error: msg }
		}

		if (meta.latestRev <= 0) {
			return { ok: false, runId, error: '[univer] workbook not initialized yet (wait for initial save)' }
		}

		const baseRev = typeof input.baseRev === 'number' && Number.isFinite(input.baseRev) ? input.baseRev : meta.latestRev
		if (baseRev !== meta.latestRev) {
			return { ...conflictResult({ currentRev: meta.latestRev, latestSnapshotUrl: meta.latestSnapshotUrl, latestEtag: meta.latestEtag }), runId }
		}

		const snap = store.getSnapshot(workbookId, baseRev)
		if (!snap) return { ok: false, runId, error: `[univer] snapshot not found: ${workbookId}@${baseRev}` }

		let snapshot: unknown
		try {
			snapshot = JSON.parse(snap.json)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			return { ok: false, runId, error: `[univer] invalid snapshot json: ${msg}` }
		}

		let conn
		try {
			conn = await this.llm.connection(
				input.llmProfileId
					? { profileId: input.llmProfileId, traceId: runId, sessionId: workbookId }
					: { traceId: runId, sessionId: workbookId },
			)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			log.warn?.('UniverLoopback llm connection failed', { error: e })
			return { ok: false, runId, error: msg }
		}
		log.info?.('UniverLoopback llm resolved', {
			profile: {
				id: String((conn.profile as any)?.id ?? ''),
				title: String((conn.profile as any)?.title ?? ''),
				provider: String((conn.profile as any)?.provider ?? ''),
				model: String((conn.profile as any)?.model ?? ''),
				baseURL: String((conn.profile as any)?.baseURL ?? ''),
			},
		})

		const loggedConn = { ...conn, fetch: wrapFetchWithLogging(conn.fetch, log) }
		const ai = createAxAIFromConnection(loggedConn)

		try {
			const t0 = Date.now()
			return await this.engine.withWorkbook(snapshot, async (workbook) => {
				const bridge = createUniverAiBridge(workbook)
				const res = await runUniverAxLoopback(
					ai,
					bridge,
					{
						instruction,
						scopes: input.scopes,
						contexts: input.contexts,
						maxRounds: input.maxRounds,
						mode: input.mode,
						limits: input.limits,
						contract: input.contract,
						toolPolicy: input.toolPolicy,
					},
					{ logger: log as any },
				)

				if (!res.ok) {
					log.warn?.('UniverLoopback failed', { error: res.error, ms: Date.now() - t0 })
					return { ok: false, runId, error: res.error }
				}

				const saveFn = (workbook as any)?.save
				if (typeof saveFn !== 'function') throw new Error('[univer] workbook.save() missing')
				const nextSnapshot = saveFn.call(workbook)
				const nextJson = JSON.stringify(nextSnapshot)
				if (!nextJson) throw new Error('[univer] empty snapshot json after loopback')

				if (nextJson === snap.json) {
					// No change: keep the current snapshot pointers.
					log.info?.('UniverLoopback ok (no-op)', {
						baseRev,
						newRev: baseRev,
						rounds: res.rounds,
						appliedOps: res.stats.appliedOps + res.stats.appliedClears,
						ms: Date.now() - t0,
					})
					return {
						ok: true,
						runId,
						baseRev,
						newRev: baseRev,
						snapshotUrl: store.snapshotUrl(workbookId, baseRev),
						etag: snap.etag,
						rounds: res.rounds,
						appliedOps: res.stats.appliedOps + res.stats.appliedClears,
						summary: res.summary,
					}
				}

				const committed = store.commitSnapshot({ id: workbookId, baseRev, json: nextJson })
				if (isConflictCommitResult(committed)) {
					log.warn?.('UniverLoopback conflict on commit', { ...committed, ms: Date.now() - t0 })
					return { ...conflictResult({
						currentRev: committed.currentRev,
						latestSnapshotUrl: committed.latestSnapshotUrl,
						latestEtag: committed.latestEtag,
					}), runId }
				}

				log.info?.('UniverLoopback ok (committed)', {
					baseRev,
					newRev: committed.newRev,
					rounds: res.rounds,
					appliedOps: res.stats.appliedOps + res.stats.appliedClears,
					ms: Date.now() - t0,
				})
				return {
					ok: true,
					runId,
					baseRev,
					newRev: committed.newRev,
					snapshotUrl: committed.newSnapshotUrl,
					etag: committed.newEtag,
					rounds: res.rounds,
					appliedOps: res.stats.appliedOps + res.stats.appliedClears,
					summary: res.summary,
				}
			})
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			return { ok: false, runId, error: msg }
		}
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
