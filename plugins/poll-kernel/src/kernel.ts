import { nanoid } from '@pluxel/toolkit/id'
import { SieveCache } from '@pluxel/toolkit/cache'
import type { AdminCtx, BatchReq, Decision, PollKernelDriver, PollSpec, ResultsSnapshot, SelectionInput, VoteCtx } from './core.js'
import type { Repo } from './repo.js'
import { normalizeSpec } from './spec.js'

export type KernelOptions = {
	enableInProcessQueue: boolean
	snapshotCacheSize: number
	queueCacheSize: number
}

type Task<T> = () => Promise<T>

function createSerialQueue(): <T>(task: Task<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve()
	return async <T>(task: Task<T>): Promise<T> => {
		const run = tail.then(task, task)
		// Ensure the queue continues even if the task rejects.
		tail = run.then(
			() => undefined,
			() => undefined,
		)
		return await run
	}
}

export class PollKernelEngine implements PollKernelDriver {
	private readonly snapshotCache: SieveCache<string, ResultsSnapshot> | null
	private readonly queues: SieveCache<string, (task: Task<unknown>) => Promise<unknown>>

	constructor(private readonly repo: Repo, private readonly options: KernelOptions) {
		this.snapshotCache =
			options.snapshotCacheSize > 0 ? new SieveCache(options.snapshotCacheSize) : null
		this.queues = new SieveCache(Math.max(1, options.queueCacheSize))
	}

	async createPoll(spec: PollSpec, ctx: AdminCtx): Promise<{ pollId: string }> {
		const normalized = normalizeSpec(spec)
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const pollId = nanoid()
			try {
				await this.repo.createPoll(pollId, normalized.spec, ctx.now)
				const snapshot: ResultsSnapshot = {
					pollId,
					version: 1,
					closed: false,
					openAt: normalized.spec.openAt,
					closeAt: normalized.spec.closeAt,
					participants: 0,
					counts: Array.from({ length: normalized.choiceCount }, () => 0n),
					totals: Array.from({ length: normalized.choiceCount }, () => 0n),
				}
				this.setSnapshot(snapshot)
				return { pollId }
			} catch (error) {
				if (attempt >= 2) throw error
			}
		}
		throw new Error('[PollKernel] failed to create poll')
	}

	async castVote(pollId: string, selection: SelectionInput, ctx: VoteCtx): Promise<Decision> {
		const [decision] = await this.mutateBatch(pollId, [
			{ type: 'cast', selection, ctx },
		])
		return decision
	}

	async retractVote(pollId: string, ctx: VoteCtx): Promise<Decision> {
		const [decision] = await this.mutateBatch(pollId, [{ type: 'retract', ctx }])
		return decision
	}

	async closePoll(pollId: string, ctx: AdminCtx): Promise<Decision> {
		const [decision] = await this.mutateBatch(pollId, [{ type: 'close', ctx }])
		return decision
	}

	async mutateBatch(pollId: string, reqs: BatchReq[]): Promise<Decision[]> {
		return await this.withQueue(pollId, async () => {
			const decisions = await this.repo.mutateBatch(pollId, reqs)
			if (this.snapshotCache && decisions.some((d) => d.changed)) {
				const snapshot = await this.getResultsSnapshot(pollId, latestNow(reqs))
				if (snapshot) this.setSnapshot(snapshot)
			}
			return decisions
		})
	}

	async getResults(pollId: string, now: number): Promise<ResultsSnapshot | null> {
		return await this.getResultsSnapshot(pollId, now)
	}

	async dispose(): Promise<void> {
		await this.repo.dispose?.()
	}

	private async getResultsSnapshot(pollId: string, now: number): Promise<ResultsSnapshot | null> {
		const cached = this.snapshotCache?.get(pollId)
		const meta = await this.repo.loadMeta(pollId)
		if (!meta) return null

		if (cached && cached.version === meta.version) {
			return this.snapshotForNow(cached, now)
		}

		const aggs = await this.repo.loadAgg(pollId)
		const counts: bigint[] = Array.from({ length: meta.spec.choices.length }, () => 0n)
		const totals: bigint[] = Array.from({ length: meta.spec.choices.length }, () => 0n)
		for (const agg of aggs) {
			if (agg.idx >= 0 && agg.idx < counts.length) {
				counts[agg.idx] = agg.count
				totals[agg.idx] = agg.total
			}
		}

		const closed = meta.closed || (meta.closeAt !== undefined && now >= meta.closeAt)
		const snapshot: ResultsSnapshot = {
			pollId: meta.pollId,
			version: meta.version,
			closed,
			openAt: meta.openAt,
			closeAt: meta.closeAt,
			participants: meta.participants,
			counts,
			totals,
		}
		this.setSnapshot(snapshot)
		return snapshot
	}

	private snapshotForNow(snapshot: ResultsSnapshot, now: number): ResultsSnapshot {
		const closed = snapshot.closed || (snapshot.closeAt !== undefined && now >= snapshot.closeAt)
		if (closed === snapshot.closed) return snapshot
		return { ...snapshot, closed }
	}

	private setSnapshot(snapshot: ResultsSnapshot): void {
		this.snapshotCache?.set(snapshot.pollId, snapshot)
	}

	private withQueue<T>(pollId: string, task: Task<T>): Promise<T> {
		if (!this.options.enableInProcessQueue) return task()
		const queue = this.getQueue(pollId)
		return queue(task) as Promise<T>
	}

	private getQueue(pollId: string): (task: Task<unknown>) => Promise<unknown> {
		const existing = this.queues.get(pollId)
		if (existing) return existing
		const enqueue = createSerialQueue() as (task: Task<unknown>) => Promise<unknown>
		this.queues.set(pollId, enqueue)
		return enqueue
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
