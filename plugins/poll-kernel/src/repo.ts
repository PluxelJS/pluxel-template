import { createHash } from 'node:crypto'
import { SieveCache } from '@pluxel/toolkit/cache'
import type { MikroOrm } from 'pluxel-plugin-mikro-orm'
import { EntitySchema } from 'pluxel-plugin-mikro-orm/mikro-orm/core'
import type { BatchReq, Decision, PollSpec, SelectionInput } from './core.js'
import { decodeSpec, encodeSpec, normalizeSpec, resolveWeight } from './spec.js'
import {
	decodeSelection,
	diffSelection,
	encodeSelection,
	forEachIntersection,
	parseSelection,
	selectionEquals,
	selectionToIndices,
	validateSelection,
	type NormalizedSpec,
} from './selection.js'
import type { Selection } from './core.js'

export type PollMeta = {
	pollId: string
	spec: PollSpec
	closed: boolean
	openAt?: number
	closeAt?: number
	participants: number
	version: number
	updatedAtMs: number
}

export type ChoiceAgg = {
	idx: number
	count: bigint
	total: bigint
}

export interface Repo {
	createPoll: (pollId: string, spec: PollSpec, now: number) => Promise<void>
	mutateBatch: (pollId: string, reqs: BatchReq[]) => Promise<Decision[]>
	loadMeta: (pollId: string) => Promise<PollMeta | null>
	loadAgg: (pollId: string) => Promise<ChoiceAgg[]>
	dispose?: () => Promise<void>
}

export type RepoOptions = {
	scopeKey: string
	ensureSchema: boolean
	dropTableOnDispose: boolean
	specCacheSize: number
}

type Tables = {
	meta: string
	choiceAgg: string
	vote: string
	request: string
	dispose: () => Promise<void>
}

type SqlEntityManager = {
	execute: (sql: string, params?: unknown[], method?: 'all' | 'get' | 'run') => Promise<unknown>
	transactional: <T>(fn: (em: SqlEntityManager) => Promise<T>) => Promise<T>
}

type VoteRecord = { sel: Selection; w: bigint }

type StoredDecision = Omit<Decision, 'results'>

type RequestRow = { payloadHash: string; resultJson: string; version: number }

type PendingInsert = {
	requestId: string
	payloadHash: string
	decision: StoredDecision
	createdAtMs: number
}

function quoteIdent(ident: string): string {
	return `"${ident.replaceAll('"', '""')}"`
}

function resultRows<T>(r: unknown): T[] {
	if (Array.isArray(r)) return r as T[]
	if (r == null) return []
	return [r as T]
}

function requiredString(row: Record<string, unknown>, key: string): string {
	const v = row[key]
	if (v == null) throw new Error(`[PollKernel] missing column: ${key}`)
	return String(v)
}

function requiredNumber(row: Record<string, unknown>, key: string): number {
	const v = row[key]
	if (v == null) throw new Error(`[PollKernel] missing column: ${key}`)
	return Number(v)
}

function requiredBoolean(row: Record<string, unknown>, key: string): boolean {
	const v = row[key]
	if (v == null) throw new Error(`[PollKernel] missing column: ${key}`)
	if (v === true || v === false) return v
	if (v === 1 || v === 0) return v === 1
	if (v === '1' || v === '0') return v === '1'
	return Boolean(v)
}

function requiredBigIntText(row: Record<string, unknown>, key: string): bigint {
	const v = row[key]
	if (v == null) throw new Error(`[PollKernel] missing column: ${key}`)
	return BigInt(String(v))
}

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex')
}

function encodeDecision(decision: StoredDecision): string {
	return JSON.stringify(decision)
}

function decodeDecision(raw: string): StoredDecision {
	const parsed = JSON.parse(raw) as StoredDecision
	return parsed
}

export class MikroRepo implements Repo {
	private tablesPromise: Promise<Tables> | undefined
	private readonly specCache: SieveCache<string, NormalizedSpec>

	constructor(
		private readonly mikro: MikroOrm,
		private readonly options: RepoOptions,
	) {
		this.specCache = new SieveCache(Math.max(1, Math.floor(options.specCacheSize)))
	}

	private async ensureTables(): Promise<Tables> {
		if (this.tablesPromise) return await this.tablesPromise

		this.tablesPromise = (async () => {
			const PollMetaRow = new EntitySchema({
				name: 'PollMeta',
				tableName: 'poll_meta',
				properties: {
					poll_id: { primary: true, type: 'string' },
					spec_json: { type: 'string', columnType: 'text' },
					closed: { type: 'boolean' },
					open_at_ms: { type: 'number', nullable: true },
					close_at_ms: { type: 'number', nullable: true },
					participants: { type: 'number' },
					version: { type: 'number' },
					created_at_ms: { type: 'number' },
					updated_at_ms: { type: 'number' },
				},
			})
			PollMetaRow.addIndex({ properties: ['updated_at_ms'] })

			const PollChoiceAggRow = new EntitySchema({
				name: 'PollChoiceAgg',
				tableName: 'poll_choice_agg',
				properties: {
					poll_id: { primary: true, type: 'string' },
					choice_idx: { primary: true, type: 'number' },
					count_text: { type: 'string', columnType: 'text' },
					total_text: { type: 'string', columnType: 'text' },
				},
			})
			PollChoiceAggRow.addIndex({ properties: ['poll_id'] })

			const PollVoteRow = new EntitySchema({
				name: 'PollVote',
				tableName: 'poll_vote',
				properties: {
					poll_id: { primary: true, type: 'string' },
					principal_id: { primary: true, type: 'string' },
					sel_kind: { type: 'string' },
					sel_data: { type: 'string', columnType: 'text' },
					weight_text: { type: 'string', columnType: 'text' },
					updated_at_ms: { type: 'number' },
				},
			})
			PollVoteRow.addIndex({ properties: ['poll_id'] })

			const PollRequestRow = new EntitySchema({
				name: 'PollRequest',
				tableName: 'poll_request',
				properties: {
					poll_id: { primary: true, type: 'string' },
					request_id: { primary: true, type: 'string' },
					payload_hash: { type: 'string' },
					result_json: { type: 'string', columnType: 'text' },
					version: { type: 'number' },
					created_at_ms: { type: 'number' },
				},
			})
			PollRequestRow.addIndex({ properties: ['poll_id'] })

			const scope = this.mikro.scope(this.options.scopeKey)
			const batch = await scope.registerEntities([PollMetaRow, PollChoiceAggRow, PollVoteRow, PollRequestRow], {
				ensureSchema: this.options.ensureSchema,
				dropTableOnDispose: this.options.dropTableOnDispose,
			})

			const map = new Map(batch.entities.map((e) => [e.baseTableName, e.tableName]))
			const get = (base: string) => {
				const t = map.get(base)
				if (!t) throw new Error(`[PollKernel] missing table ${base}`)
				return t
			}

			return {
				meta: get('poll_meta'),
				choiceAgg: get('poll_choice_agg'),
				vote: get('poll_vote'),
				request: get('poll_request'),
				dispose: batch.dispose,
			}
		})()

		return await this.tablesPromise
	}

	private async sqlEm(): Promise<SqlEntityManager> {
		return (await this.mikro.sqlEm()) as unknown as SqlEntityManager
	}

	async createPoll(pollId: string, spec: PollSpec, now: number): Promise<void> {
		const tables = await this.ensureTables()
		const em = await this.sqlEm()
		const normalized = normalizeSpec(spec)
		const specJson = encodeSpec(normalized.spec)

		await em.transactional(async (tx) => {
			await tx.execute(
				`INSERT INTO ${quoteIdent(tables.meta)} (${quoteIdent('poll_id')}, ${quoteIdent(
					'spec_json',
				)}, ${quoteIdent('closed')}, ${quoteIdent('open_at_ms')}, ${quoteIdent('close_at_ms')}, ${quoteIdent(
					'participants',
				)}, ${quoteIdent('version')}, ${quoteIdent('created_at_ms')}, ${quoteIdent(
					'updated_at_ms',
				)}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					pollId,
					specJson,
					false,
					normalized.spec.openAt ?? null,
					normalized.spec.closeAt ?? null,
					0,
					1,
					now,
					now,
				],
			)

			const valuesSql: string[] = []
			const params: unknown[] = []
			for (let i = 0; i < normalized.choiceCount; i += 1) {
				valuesSql.push('(?, ?, ?, ?)')
				params.push(pollId, i, '0', '0')
			}

			await tx.execute(
				`INSERT INTO ${quoteIdent(tables.choiceAgg)} (${quoteIdent('poll_id')}, ${quoteIdent(
					'choice_idx',
				)}, ${quoteIdent('count_text')}, ${quoteIdent('total_text')}) VALUES ${valuesSql.join(',')}`,
				params,
			)
		})
	}

	async mutateBatch(pollId: string, reqs: BatchReq[]): Promise<Decision[]> {
		if (reqs.length === 0) return []
		const tables = await this.ensureTables()
		const em = await this.sqlEm()
		const nowMax = latestNow(reqs)

		return await em.transactional(async (tx) => {
			const metaRow = (await tx.execute(
				`UPDATE ${quoteIdent(tables.meta)} SET ${quoteIdent('updated_at_ms')} = ${quoteIdent(
					'updated_at_ms',
				)} WHERE ${quoteIdent('poll_id')} = ? RETURNING ${quoteIdent('poll_id')}, ${quoteIdent(
					'spec_json',
				)}, ${quoteIdent('closed')}, ${quoteIdent('open_at_ms')}, ${quoteIdent(
					'close_at_ms',
				)}, ${quoteIdent('participants')}, ${quoteIdent('version')}, ${quoteIdent('updated_at_ms')}`,
				[pollId],
				'get',
			)) as Record<string, unknown> | undefined

			if (!metaRow) {
				return reqs.map(() => ({
					ok: false,
					code: 'INVALID',
					changed: false,
					version: 0,
				}))
			}

			const specJson = requiredString(metaRow, 'spec_json')
			const normalized = this.getNormalizedSpec(specJson)
			let closed = requiredBoolean(metaRow, 'closed')
			const openAt = metaRow['open_at_ms'] == null ? undefined : Number(metaRow['open_at_ms'])
			const closeAt = metaRow['close_at_ms'] == null ? undefined : Number(metaRow['close_at_ms'])
			let participants = requiredNumber(metaRow, 'participants')
			const version = requiredNumber(metaRow, 'version')

			const uniqueRequestIds = new Set<string>()
			const uniquePrincipals = new Set<string>()
			for (const req of reqs) {
				uniqueRequestIds.add(req.ctx.requestId)
				if (req.type === 'cast' || req.type === 'retract') {
					uniquePrincipals.add(req.ctx.principalId)
				}
			}

			const existingRequests = await this.prefetchRequests(
				tx,
				tables.request,
				pollId,
				Array.from(uniqueRequestIds),
			)
			let counts: bigint[] | null = null
			let totals: bigint[] | null = null
			let voteCache: Map<string, VoteRecord | null> | null = null
			const localRequests = new Map<string, { hash: string; decision: StoredDecision }>()
			const pending: PendingInsert[] = []
			const decisions: Decision[] = []
			const touchedChoices = new Set<number>()
			let anyChanged = false

			const ensureLoaded = async (): Promise<void> => {
				if (counts && totals && voteCache) return
				const aggRows = resultRows<Record<string, unknown>>(
					await tx.execute(
						`SELECT ${quoteIdent('choice_idx')}, ${quoteIdent('count_text')}, ${quoteIdent(
							'total_text',
						)} FROM ${quoteIdent(tables.choiceAgg)} WHERE ${quoteIdent('poll_id')} = ? ORDER BY ${quoteIdent(
							'choice_idx',
						)}`,
						[pollId],
						'all',
					),
				)
				counts = Array.from({ length: normalized.choiceCount }, () => 0n)
				totals = Array.from({ length: normalized.choiceCount }, () => 0n)
				for (const row of aggRows) {
					const idx = requiredNumber(row, 'choice_idx')
					if (idx >= 0 && idx < normalized.choiceCount) {
						counts[idx] = requiredBigIntText(row, 'count_text')
						totals[idx] = requiredBigIntText(row, 'total_text')
					}
				}
				voteCache = await this.prefetchVotes(
					tx,
					tables.vote,
					pollId,
					Array.from(uniquePrincipals),
				)
				for (const principalId of uniquePrincipals) {
					if (!voteCache.has(principalId)) voteCache.set(principalId, null)
				}
			}

			const loadVote = async (principalId: string): Promise<VoteRecord | null> => {
				const cached = voteCache?.get(principalId)
				return cached === undefined ? null : cached
			}

			for (const req of reqs) {
				const requestId = req.type === 'close' ? req.ctx.requestId : req.ctx.requestId
				const payload = this.payloadFor(req, normalized)
				const payloadHash = sha256(payload)

				const local = localRequests.get(requestId)
				if (local) {
					if (local.hash !== payloadHash) {
						decisions.push({
							ok: false,
							code: 'IDEMPOTENT_MISMATCH',
							changed: false,
							version: local.decision.version,
						})
					} else {
						decisions.push({ ...local.decision })
					}
					continue
				}

				const existing = existingRequests.get(requestId)
				if (existing) {
					if (existing.payloadHash !== payloadHash) {
						const mismatchDecision: StoredDecision = {
							ok: false,
							code: 'IDEMPOTENT_MISMATCH',
							changed: false,
							version: existing.version,
						}
						localRequests.set(requestId, { hash: payloadHash, decision: mismatchDecision })
						decisions.push(mismatchDecision)
					} else {
						const stored = decodeDecision(existing.resultJson)
						localRequests.set(requestId, { hash: payloadHash, decision: stored })
						decisions.push(stored)
					}
					continue
				}

				if (req.type !== 'close') {
					await ensureLoaded()
				}
				const result = await this.applyRequest({
					req,
					normalized,
					closed,
					openAt,
					closeAt,
					counts: counts ?? [],
					totals: totals ?? [],
					loadVote,
					updateVote: async (principalId, record) => {
						if (!record) {
							await tx.execute(
								`DELETE FROM ${quoteIdent(tables.vote)} WHERE ${quoteIdent('poll_id')} = ? AND ${quoteIdent(
									'principal_id',
								)} = ?`,
								[pollId, principalId],
							)
						} else {
							const encoded = encodeSelection(record.sel)
							await tx.execute(
								`INSERT INTO ${quoteIdent(tables.vote)} (${quoteIdent('poll_id')}, ${quoteIdent(
									'principal_id',
								)}, ${quoteIdent('sel_kind')}, ${quoteIdent('sel_data')}, ${quoteIdent(
									'weight_text',
								)}, ${quoteIdent('updated_at_ms')}) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (${quoteIdent(
									'poll_id',
								)}, ${quoteIdent('principal_id')}) DO UPDATE SET ${quoteIdent(
									'sel_kind',
								)} = excluded.${quoteIdent('sel_kind')}, ${quoteIdent(
									'sel_data',
								)} = excluded.${quoteIdent('sel_data')}, ${quoteIdent(
									'weight_text',
								)} = excluded.${quoteIdent('weight_text')}, ${quoteIdent(
									'updated_at_ms',
								)} = excluded.${quoteIdent('updated_at_ms')}`,
								[pollId, principalId, encoded.kind, encoded.data, record.w.toString(10), nowMax],
							)
						}
						voteCache.set(principalId, record)
					},
					onParticipantDelta: (delta) => {
						participants += delta
					},
					onClosedChange: (next) => {
						closed = next
					},
					onTouched: (idx) => touchedChoices.add(idx),
				})

				if (result.changed) anyChanged = true
				localRequests.set(requestId, { hash: payloadHash, decision: result })
				decisions.push(result)

				pending.push({
					requestId,
					payloadHash,
					decision: result,
					createdAtMs: nowMax,
				})
			}

			const nextVersion = anyChanged ? version + 1 : version

			for (const decision of decisions) {
				if (decision.version === 0) decision.version = nextVersion
			}
			for (const record of pending) {
				record.decision.version = nextVersion
			}

			if (touchedChoices.size > 0) {
				const currentCounts = counts ?? []
				const currentTotals = totals ?? []
				for (const idx of touchedChoices) {
					await tx.execute(
						`UPDATE ${quoteIdent(tables.choiceAgg)} SET ${quoteIdent('count_text')} = ?, ${quoteIdent(
							'total_text',
						)} = ? WHERE ${quoteIdent('poll_id')} = ? AND ${quoteIdent('choice_idx')} = ?`,
						[currentCounts[idx]!.toString(10), currentTotals[idx]!.toString(10), pollId, idx],
					)
				}
			}

			if (anyChanged) {
				await tx.execute(
					`UPDATE ${quoteIdent(tables.meta)} SET ${quoteIdent('closed')} = ?, ${quoteIdent(
						'participants',
					)} = ?, ${quoteIdent('version')} = ?, ${quoteIdent('updated_at_ms')} = ? WHERE ${quoteIdent(
						'poll_id',
					)} = ?`,
					[closed, participants, nextVersion, nowMax, pollId],
				)
			}

			if (pending.length > 0) {
				const valuesSql: string[] = []
				const params: unknown[] = []
				for (const record of pending) {
					valuesSql.push('(?, ?, ?, ?, ?, ?)')
					params.push(
						pollId,
						record.requestId,
						record.payloadHash,
						encodeDecision(record.decision),
						record.decision.version,
						record.createdAtMs,
					)
				}
				await tx.execute(
					`INSERT INTO ${quoteIdent(tables.request)} (${quoteIdent('poll_id')}, ${quoteIdent(
						'request_id',
					)}, ${quoteIdent('payload_hash')}, ${quoteIdent('result_json')}, ${quoteIdent(
						'version',
					)}, ${quoteIdent('created_at_ms')}) VALUES ${valuesSql.join(',')}`,
					params,
				)
			}

			return decisions
		})
	}

	async loadMeta(pollId: string): Promise<PollMeta | null> {
		const tables = await this.ensureTables()
		const em = await this.sqlEm()
		const row = (await em.execute(
			`SELECT ${quoteIdent('poll_id')}, ${quoteIdent('spec_json')}, ${quoteIdent(
				'closed',
			)}, ${quoteIdent('open_at_ms')}, ${quoteIdent('close_at_ms')}, ${quoteIdent(
				'participants',
			)}, ${quoteIdent('version')}, ${quoteIdent('updated_at_ms')} FROM ${quoteIdent(
				tables.meta,
			)} WHERE ${quoteIdent('poll_id')} = ?`,
			[pollId],
			'get',
		)) as Record<string, unknown> | undefined

		if (!row) return null
		const spec = decodeSpec(requiredString(row, 'spec_json'))
		return {
			pollId: requiredString(row, 'poll_id'),
			spec,
			closed: requiredBoolean(row, 'closed'),
			openAt: row['open_at_ms'] == null ? undefined : Number(row['open_at_ms']),
			closeAt: row['close_at_ms'] == null ? undefined : Number(row['close_at_ms']),
			participants: requiredNumber(row, 'participants'),
			version: requiredNumber(row, 'version'),
			updatedAtMs: requiredNumber(row, 'updated_at_ms'),
		}
	}

	async loadAgg(pollId: string): Promise<ChoiceAgg[]> {
		const tables = await this.ensureTables()
		const em = await this.sqlEm()
		const rows = resultRows<Record<string, unknown>>(
			await em.execute(
				`SELECT ${quoteIdent('choice_idx')}, ${quoteIdent('count_text')}, ${quoteIdent(
					'total_text',
				)} FROM ${quoteIdent(tables.choiceAgg)} WHERE ${quoteIdent('poll_id')} = ? ORDER BY ${quoteIdent(
					'choice_idx',
				)}`,
				[pollId],
				'all',
			),
		)

		return rows.map((row) => ({
			idx: requiredNumber(row, 'choice_idx'),
			count: requiredBigIntText(row, 'count_text'),
			total: requiredBigIntText(row, 'total_text'),
		}))
	}

	async dispose(): Promise<void> {
		const tables = await this.ensureTables()
		await tables.dispose()
	}

	private getNormalizedSpec(specJson: string): NormalizedSpec {
		const cached = this.specCache.get(specJson)
		if (cached) return cached
		const spec = decodeSpec(specJson)
		const normalized = normalizeSpec(spec)
		this.specCache.set(specJson, normalized)
		return normalized
	}

	private async prefetchRequests(
		em: SqlEntityManager,
		table: string,
		pollId: string,
		requestIds: string[],
	): Promise<Map<string, RequestRow>> {
		const map = new Map<string, RequestRow>()
		if (requestIds.length === 0) return map
		const chunkSize = 200
		for (let i = 0; i < requestIds.length; i += chunkSize) {
			const slice = requestIds.slice(i, i + chunkSize)
			const placeholders = slice.map(() => '?').join(',')
			const rows = resultRows<Record<string, unknown>>(
				await em.execute(
					`SELECT ${quoteIdent('request_id')}, ${quoteIdent('payload_hash')}, ${quoteIdent(
						'result_json',
					)}, ${quoteIdent('version')} FROM ${quoteIdent(table)} WHERE ${quoteIdent(
						'poll_id',
					)} = ? AND ${quoteIdent('request_id')} IN (${placeholders})`,
					[pollId, ...slice],
					'all',
				),
			)
			for (const row of rows) {
				const requestId = requiredString(row, 'request_id')
				map.set(requestId, {
					payloadHash: requiredString(row, 'payload_hash'),
					resultJson: requiredString(row, 'result_json'),
					version: requiredNumber(row, 'version'),
				})
			}
		}
		return map
	}

	private async prefetchVotes(
		em: SqlEntityManager,
		table: string,
		pollId: string,
		principalIds: string[],
	): Promise<Map<string, VoteRecord | null>> {
		const map = new Map<string, VoteRecord | null>()
		if (principalIds.length === 0) return map
		const chunkSize = 200
		for (let i = 0; i < principalIds.length; i += chunkSize) {
			const slice = principalIds.slice(i, i + chunkSize)
			const placeholders = slice.map(() => '?').join(',')
			const rows = resultRows<Record<string, unknown>>(
				await em.execute(
					`SELECT ${quoteIdent('principal_id')}, ${quoteIdent('sel_kind')}, ${quoteIdent(
						'sel_data',
					)}, ${quoteIdent('weight_text')} FROM ${quoteIdent(table)} WHERE ${quoteIdent(
						'poll_id',
					)} = ? AND ${quoteIdent('principal_id')} IN (${placeholders})`,
					[pollId, ...slice],
					'all',
				),
			)
			for (const row of rows) {
				const principalId = requiredString(row, 'principal_id')
				const selKind = requiredString(row, 'sel_kind')
				const selData = requiredString(row, 'sel_data')
				const sel = decodeSelection(selKind, selData)
				if (!sel) {
					throw new Error('[PollKernel] invalid selection encoding')
				}
				const w = requiredBigIntText(row, 'weight_text')
				map.set(principalId, { sel, w })
			}
		}
		return map
	}

	private payloadFor(req: BatchReq, normalized: NormalizedSpec): string {
		if (req.type === 'close') {
			return JSON.stringify({ op: 'close', requestId: req.ctx.requestId })
		}
		if (req.type === 'retract') {
			return JSON.stringify({
				op: 'retract',
				principalId: req.ctx.principalId,
				requestId: req.ctx.requestId,
			})
		}
		const selectionKey = buildSelectionKey(req.selection, normalized)
		const resolved = resolveWeight(normalized.spec, req.ctx)
		const weightKey =
			typeof resolved === 'string'
				? req.ctx.weight !== undefined
					? req.ctx.weight.toString(10)
					: ''
				: resolved.toString(10)
		return JSON.stringify({
			op: 'cast',
			principalId: req.ctx.principalId,
			requestId: req.ctx.requestId,
			selection: selectionKey,
			weight: weightKey,
		})
	}

	private async applyRequest(args: {
		req: BatchReq
		normalized: NormalizedSpec
		closed: boolean
		openAt?: number
		closeAt?: number
		counts: bigint[]
		totals: bigint[]
		loadVote: (principalId: string) => Promise<VoteRecord | null>
		updateVote: (principalId: string, record: VoteRecord | null) => Promise<void>
		onParticipantDelta: (delta: number) => void
		onClosedChange: (closed: boolean) => void
		onTouched: (idx: number) => void
	}): Promise<StoredDecision> {
		const { req, normalized, counts, totals } = args
		if (req.type === 'close') {
			if (args.closed) {
				return { ok: true, code: 'OK', changed: false, version: 0 }
			}
			args.onClosedChange(true)
			return { ok: true, code: 'OK', changed: true, version: 0 }
		}

		const now = req.ctx.now
		if (args.openAt !== undefined && now < args.openAt) {
			return { ok: false, code: 'NOT_OPEN', changed: false, version: 0 }
		}
		if (args.closed || (args.closeAt !== undefined && now >= args.closeAt)) {
			return { ok: false, code: 'CLOSED', changed: false, version: 0 }
		}

		if (req.type === 'retract') {
			if (normalized.spec.allowRetract === false) {
				return { ok: false, code: 'RETRACT_FORBIDDEN', changed: false, version: 0 }
			}
			const old = await args.loadVote(req.ctx.principalId)
			if (!old) return { ok: false, code: 'NO_VOTE', changed: false, version: 0 }
			selectionToIndices(old.sel).forEach((idx) => {
				counts[idx] = counts[idx]! - 1n
				totals[idx] = totals[idx]! - old.w
				args.onTouched(idx)
			})
			await args.updateVote(req.ctx.principalId, null)
			args.onParticipantDelta(-1)
			return { ok: true, code: 'OK', changed: true, version: 0 }
		}

		const selection = parseSelectionInput(req.selection, normalized)
		if (typeof selection === 'string') {
			return { ok: false, code: selection, changed: false, version: 0 }
		}

		const weight = resolveWeight(normalized.spec, req.ctx)
		if (typeof weight === 'string') {
			return { ok: false, code: weight, changed: false, version: 0 }
		}

		const old = await args.loadVote(req.ctx.principalId)
		if (old) {
			if (normalized.spec.allowUpdate === false) {
				if (selectionEquals(old.sel, selection) && old.w === weight) {
					return { ok: true, code: 'OK', changed: false, version: 0 }
				}
				return { ok: false, code: 'UPDATE_FORBIDDEN', changed: false, version: 0 }
			}

			if (selectionEquals(old.sel, selection)) {
				if (old.w === weight) {
					return { ok: true, code: 'OK', changed: false, version: 0 }
				}
				const delta = weight - old.w
				selectionToIndices(selection).forEach((idx) => {
					totals[idx] = totals[idx]! + delta
					args.onTouched(idx)
				})
				await args.updateVote(req.ctx.principalId, { sel: selection, w: weight })
				return { ok: true, code: 'OK', changed: true, version: 0 }
			}

			diffSelection(
				old.sel,
				selection,
				(idx) => {
					counts[idx] = counts[idx]! - 1n
					totals[idx] = totals[idx]! - old.w
					args.onTouched(idx)
				},
				(idx) => {
					counts[idx] = counts[idx]! + 1n
					totals[idx] = totals[idx]! + weight
					args.onTouched(idx)
				},
			)
			if (old.w !== weight) {
				const delta = weight - old.w
				forEachIntersection(old.sel, selection, (idx) => {
					totals[idx] = totals[idx]! + delta
					args.onTouched(idx)
				})
			}
			await args.updateVote(req.ctx.principalId, { sel: selection, w: weight })
			return { ok: true, code: 'OK', changed: true, version: 0 }
		}

		selectionToIndices(selection).forEach((idx) => {
			counts[idx] = counts[idx]! + 1n
			totals[idx] = totals[idx]! + weight
			args.onTouched(idx)
		})
		await args.updateVote(req.ctx.principalId, { sel: selection, w: weight })
		args.onParticipantDelta(1)
		return { ok: true, code: 'OK', changed: true, version: 0 }
	}
}

function latestNow(reqs: BatchReq[]): number {
	let max = Date.now()
	for (const req of reqs) {
		if (req.type === 'close') {
			if (req.ctx.now > max) max = req.ctx.now
		} else if (req.ctx.now > max) {
			max = req.ctx.now
		}
	}
	return max
}

function parseSelectionInput(input: SelectionInput, normalized: NormalizedSpec): Selection | Code {
	if (Array.isArray(input)) return parseSelection(input, normalized)
	const validation = validateSelection(input, normalized)
	if (validation) return validation
	return input
}

function buildSelectionKey(input: SelectionInput, normalized: NormalizedSpec): { kind: string; value: unknown } {
	if (Array.isArray(input)) {
		const parsed = parseSelection(input, normalized)
		if (typeof parsed === 'string') {
			const sorted = [...input].sort()
			return { kind: 'ids', value: sorted }
		}
		return { kind: 'idx', value: selectionToIndices(parsed) }
	}
	const validation = validateSelection(input, normalized)
	if (validation) {
		const encoded = encodeSelection(input)
		return { kind: 'raw', value: { k: encoded.kind, d: encoded.data } }
	}
	return { kind: 'idx', value: selectionToIndices(input) }
}
