import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { BatchReq, PollSpec, Selection, SelectionInput } from '../src/core.js'
import { PollKernelEngine } from '../src/kernel.js'
import type { ChoiceAgg, PollMeta, Repo } from '../src/repo.js'
import { normalizeSpec, resolveWeight } from '../src/spec.js'
import {
	diffSelection,
	forEachIntersection,
	encodeSelection,
	parseSelection,
	selectionEquals,
	selectionToIndices,
	validateSelection,
} from '../src/selection.js'

type VoteRecord = { sel: Selection; w: bigint }

class MemoryRepo implements Repo {
	private metas = new Map<string, PollMeta>()
	private choices = new Map<string, { counts: bigint[]; totals: bigint[] }>()
	private votes = new Map<string, Map<string, VoteRecord>>()
	private requests = new Map<string, Map<string, { hash: string; decision: DecisionLike }>>()

	async createPoll(pollId: string, spec: PollSpec, now: number): Promise<void> {
		const normalized = normalizeSpec(spec)
		this.metas.set(pollId, {
			pollId,
			spec: normalized.spec,
			closed: false,
			openAt: normalized.spec.openAt,
			closeAt: normalized.spec.closeAt,
			participants: 0,
			version: 1,
			updatedAtMs: now,
		})
		this.choices.set(pollId, {
			counts: Array.from({ length: normalized.choiceCount }, () => 0n),
			totals: Array.from({ length: normalized.choiceCount }, () => 0n),
		})
		this.votes.set(pollId, new Map())
		this.requests.set(pollId, new Map())
	}

	async mutateBatch(pollId: string, reqs: BatchReq[]): Promise<DecisionLike[]> {
		if (reqs.length === 0) return []
		const meta = this.metas.get(pollId)
		if (!meta) {
			return reqs.map(() => ({ ok: false, code: 'INVALID', changed: false, version: 0 }))
		}
		const normalized = normalizeSpec(meta.spec)
		const choice = this.choices.get(pollId)!
		const votes = this.votes.get(pollId)!
		const requests = this.requests.get(pollId)!
		const decisions: DecisionLike[] = []
		const local = new Map<string, { hash: string; decision: DecisionLike }>()
		let anyChanged = false

		for (const req of reqs) {
			const requestId = req.ctx.requestId
			const payloadHash = sha256(payloadFor(req, normalized))
			const localEntry = local.get(requestId)
			if (localEntry) {
				decisions.push(localEntry.hash === payloadHash ? { ...localEntry.decision } : mismatch(localEntry.decision.version))
				continue
			}

			const stored = requests.get(requestId)
			if (stored) {
				const decision = stored.hash === payloadHash ? { ...stored.decision } : mismatch(stored.decision.version)
				local.set(requestId, { hash: payloadHash, decision })
				decisions.push(decision)
				continue
			}

			const decision = applyRequest(req, meta, normalized, votes, choice)
			if (decision.changed) anyChanged = true
			local.set(requestId, { hash: payloadHash, decision })
			decisions.push(decision)
			requests.set(requestId, { hash: payloadHash, decision })
		}

		if (anyChanged) {
			meta.version += 1
			meta.updatedAtMs = latestNow(reqs)
		}
		for (const decision of decisions) {
			if (decision.version === 0) decision.version = meta.version
		}
		for (const record of requests.values()) {
			if (record.decision.version === 0) record.decision.version = meta.version
		}
		return decisions
	}

	async loadMeta(pollId: string): Promise<PollMeta | null> {
		return this.metas.get(pollId) ?? null
	}

	async loadAgg(pollId: string): Promise<ChoiceAgg[]> {
		const choice = this.choices.get(pollId)
		if (!choice) return []
		return choice.counts.map((count, idx) => ({
			idx,
			count,
			total: choice.totals[idx]!,
		}))
	}
}

type DecisionLike = { ok: boolean; code: string; changed: boolean; version: number }

function applyRequest(
	req: BatchReq,
	meta: PollMeta,
	normalized: ReturnType<typeof normalizeSpec>,
	votes: Map<string, VoteRecord>,
	choice: { counts: bigint[]; totals: bigint[] },
): DecisionLike {
	if (req.type === 'close') {
		if (meta.closed) return ok(false)
		meta.closed = true
		return ok(true)
	}

	const now = req.ctx.now
	if (meta.openAt !== undefined && now < meta.openAt) return err('NOT_OPEN')
	if (meta.closed || (meta.closeAt !== undefined && now >= meta.closeAt)) return err('CLOSED')

	if (req.type === 'retract') {
		if (normalized.spec.allowRetract === false) return err('RETRACT_FORBIDDEN')
		const old = votes.get(req.ctx.principalId)
		if (!old) return err('NO_VOTE')
		for (const idx of selectionToIndices(old.sel)) {
			choice.counts[idx] -= 1n
			choice.totals[idx] -= old.w
		}
		votes.delete(req.ctx.principalId)
		meta.participants -= 1
		return ok(true)
	}

	const selection = parseSelectionInput(req.selection, normalized)
	if (typeof selection === 'string') return err(selection)
	const weight = resolveWeight(normalized.spec, req.ctx)
	if (typeof weight === 'string') return err(weight)

	const old = votes.get(req.ctx.principalId)
	if (old) {
		if (normalized.spec.allowUpdate === false) {
			if (selectionEquals(old.sel, selection) && old.w === weight) return ok(false)
			return err('UPDATE_FORBIDDEN')
		}
		if (selectionEquals(old.sel, selection)) {
			if (old.w === weight) return ok(false)
			const delta = weight - old.w
			for (const idx of selectionToIndices(selection)) {
				choice.totals[idx] += delta
			}
			votes.set(req.ctx.principalId, { sel: selection, w: weight })
			return ok(true)
		}
		diffSelection(
			old.sel,
			selection,
			(idx) => {
				choice.counts[idx] -= 1n
				choice.totals[idx] -= old.w
			},
			(idx) => {
				choice.counts[idx] += 1n
				choice.totals[idx] += weight
			},
		)
		if (old.w !== weight) {
			const delta = weight - old.w
			forEachIntersection(old.sel, selection, (idx) => {
				choice.totals[idx] += delta
			})
		}
		votes.set(req.ctx.principalId, { sel: selection, w: weight })
		return ok(true)
	}

	for (const idx of selectionToIndices(selection)) {
		choice.counts[idx] += 1n
		choice.totals[idx] += weight
	}
	votes.set(req.ctx.principalId, { sel: selection, w: weight })
	meta.participants += 1
	return ok(true)
}

function parseSelectionInput(input: SelectionInput, normalized: ReturnType<typeof normalizeSpec>) {
	if (Array.isArray(input)) return parseSelection(input, normalized)
	const validation = validateSelection(input, normalized)
	if (validation) return validation
	return input
}

function payloadFor(req: BatchReq, normalized: ReturnType<typeof normalizeSpec>) {
	if (req.type === 'close') {
		return JSON.stringify({ op: 'close', requestId: req.ctx.requestId })
	}
	if (req.type === 'retract') {
		return JSON.stringify({ op: 'retract', principalId: req.ctx.principalId, requestId: req.ctx.requestId })
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

function buildSelectionKey(input: SelectionInput, normalized: ReturnType<typeof normalizeSpec>) {
	if (Array.isArray(input)) {
		const parsed = parseSelection(input, normalized)
		if (typeof parsed === 'string') {
			return { kind: 'ids', value: [...input].sort() }
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

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex')
}

function ok(changed: boolean): DecisionLike {
	return { ok: true, code: 'OK', changed, version: 0 }
}

function err(code: string): DecisionLike {
	return { ok: false, code, changed: false, version: 0 }
}

function mismatch(version: number): DecisionLike {
	return { ok: false, code: 'IDEMPOTENT_MISMATCH', changed: false, version }
}

function latestNow(reqs: BatchReq[]): number {
	let max = Date.now()
	for (const req of reqs) {
		if (req.ctx.now > max) max = req.ctx.now
	}
	return max
}

function createEngine(repo: Repo) {
	return new PollKernelEngine(repo, {
		enableInProcessQueue: true,
		snapshotCacheSize: 16,
		queueCacheSize: 16,
	})
}

describe('poll kernel engine', () => {
	it('mutateBatch applies multiple writes and increments version once', async () => {
		const repo = new MemoryRepo()
		const engine = createEngine(repo)
		const spec: PollSpec = {
			mode: 'single',
			choices: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
		}

		const { pollId } = await engine.createPoll(spec, { requestId: 'admin', now: 1 })
		const now = 10

		const decisions = await engine.mutateBatch(pollId, [
			{ type: 'cast', selection: ['a'], ctx: { principalId: 'u1', requestId: 'r1', now } },
			{ type: 'cast', selection: ['b'], ctx: { principalId: 'u2', requestId: 'r2', now } },
		])

		expect(decisions.map((d) => d.version)).toEqual([2, 2])
		const snapshot = await engine.getResults(pollId, now)
		expect(snapshot?.version).toBe(2)
		expect(snapshot?.counts.map((v) => Number(v))).toEqual([1, 1])
		expect(snapshot?.totals.map((v) => Number(v))).toEqual([1, 1])
		expect(snapshot?.participants).toBe(2)
	})

	it('updates retained totals when weight changes with partial overlap', async () => {
		const repo = new MemoryRepo()
		const engine = createEngine(repo)
		const spec: PollSpec = {
			mode: 'multi',
			choices: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
				{ id: 'c', label: 'C' },
			],
			weight: { kind: 'external', min: 1n, max: 10n },
		}

		const { pollId } = await engine.createPoll(spec, { requestId: 'admin', now: 1 })

		await engine.castVote(pollId, ['a', 'b'], {
			principalId: 'u1',
			requestId: 'r1',
			now: 10,
			weight: 3n,
		})

		await engine.castVote(pollId, ['b', 'c'], {
			principalId: 'u1',
			requestId: 'r2',
			now: 11,
			weight: 1n,
		})

		const snapshot = await engine.getResults(pollId, 12)
		expect(snapshot?.counts.map((v) => Number(v))).toEqual([0, 1, 1])
		expect(snapshot?.totals.map((v) => Number(v))).toEqual([0, 1, 1])
	})

	it('replays idempotent requests and rejects mismatched payloads', async () => {
		const repo = new MemoryRepo()
		const engine = createEngine(repo)
		const spec: PollSpec = {
			mode: 'single',
			choices: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
		}

		const { pollId } = await engine.createPoll(spec, { requestId: 'admin', now: 1 })
		const now = 10

		const decisions = await engine.mutateBatch(pollId, [
			{ type: 'cast', selection: ['a'], ctx: { principalId: 'u1', requestId: 'r1', now } },
			{ type: 'cast', selection: ['a'], ctx: { principalId: 'u1', requestId: 'r1', now } },
			{ type: 'cast', selection: ['b'], ctx: { principalId: 'u1', requestId: 'r1', now } },
		])

		expect(decisions[0]?.code).toBe('OK')
		expect(decisions[1]?.code).toBe('OK')
		expect(decisions[2]?.code).toBe('IDEMPOTENT_MISMATCH')

		const snapshot = await engine.getResults(pollId, now)
		expect(snapshot?.counts.map((v) => Number(v))).toEqual([1, 0])
	})

	it('allowUpdate=false only permits identical replay', async () => {
		const repo = new MemoryRepo()
		const engine = createEngine(repo)
		const spec: PollSpec = {
			mode: 'single',
			allowUpdate: false,
			choices: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
		}

		const { pollId } = await engine.createPoll(spec, { requestId: 'admin', now: 1 })

		const first = await engine.castVote(pollId, ['a'], {
			principalId: 'u1',
			requestId: 'r1',
			now: 10,
		})
		const same = await engine.castVote(pollId, ['a'], {
			principalId: 'u1',
			requestId: 'r2',
			now: 11,
		})
		const blocked = await engine.castVote(pollId, ['b'], {
			principalId: 'u1',
			requestId: 'r3',
			now: 12,
		})

		expect(first.code).toBe('OK')
		expect(same.changed).toBe(false)
		expect(blocked.code).toBe('UPDATE_FORBIDDEN')
	})

	it('time window and close are enforced', async () => {
		const repo = new MemoryRepo()
		const engine = createEngine(repo)

		const futureSpec: PollSpec = {
			mode: 'single',
			openAt: 100,
			choices: [{ id: 'a', label: 'A' }],
		}
		const { pollId: futurePoll } = await engine.createPoll(futureSpec, { requestId: 'admin-1', now: 1 })
		const notOpen = await engine.castVote(futurePoll, ['a'], {
			principalId: 'u1',
			requestId: 'r1',
			now: 10,
		})
		expect(notOpen.code).toBe('NOT_OPEN')

		const closeSpec: PollSpec = {
			mode: 'single',
			closeAt: 5,
			choices: [{ id: 'a', label: 'A' }],
		}
		const { pollId: closedPoll } = await engine.createPoll(closeSpec, { requestId: 'admin-2', now: 1 })
		const closed = await engine.castVote(closedPoll, ['a'], {
			principalId: 'u1',
			requestId: 'r2',
			now: 10,
		})
		expect(closed.code).toBe('CLOSED')

		const closeNowSpec: PollSpec = {
			mode: 'single',
			choices: [{ id: 'a', label: 'A' }],
		}
		const { pollId: closeNow } = await engine.createPoll(closeNowSpec, { requestId: 'admin-3', now: 1 })
		await engine.closePoll(closeNow, { requestId: 'close', now: 20 })
		const blocked = await engine.castVote(closeNow, ['a'], {
			principalId: 'u1',
			requestId: 'r3',
			now: 21,
		})
		expect(blocked.code).toBe('CLOSED')
	})
})
