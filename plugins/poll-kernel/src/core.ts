import { BasePlugin } from '@pluxel/hmr'

export type WeightSpec =
	| { kind: 'none' }
	| { kind: 'external'; min: bigint; max: bigint }

export type PollSpec = {
	mode: 'single' | 'multi'
	choices: { id: string; label: string }[]
	openAt?: number
	closeAt?: number
	allowUpdate?: boolean
	allowRetract?: boolean
	maxSelections?: number
	weight?: WeightSpec
}

export type SelKind = 'bitset64' | 'sortedU16'

export type Selection =
	| { kind: 'bitset64'; bits: bigint }
	| { kind: 'sortedU16'; idx: Uint16Array }

export type SelectionInput = string[] | Selection

export type VoteCtx = {
	principalId: string
	requestId: string
	now: number
	weight?: bigint
}

export type AdminCtx = {
	requestId: string
	now: number
}

export type Code =
	| 'OK'
	| 'IDEMPOTENT'
	| 'IDEMPOTENT_MISMATCH'
	| 'INVALID'
	| 'NOT_OPEN'
	| 'CLOSED'
	| 'UPDATE_FORBIDDEN'
	| 'RETRACT_FORBIDDEN'
	| 'NO_VOTE'
	| 'WEIGHT_INVALID'

export type Decision = {
	ok: boolean
	code: Code
	changed: boolean
	version: number
	results?: ResultsSnapshot
}

export type ResultsSnapshot = {
	pollId: string
	version: number
	closed: boolean
	counts: bigint[]
	totals: bigint[]
	participants: number
	openAt?: number
	closeAt?: number
}

export type BatchReq =
	| { type: 'cast'; selection: SelectionInput; ctx: VoteCtx }
	| { type: 'retract'; ctx: VoteCtx }
	| { type: 'close'; ctx: AdminCtx }

export type PollKernelDriver = {
	createPoll: (spec: PollSpec, ctx: AdminCtx) => Promise<{ pollId: string }>
	castVote: (pollId: string, selection: SelectionInput, ctx: VoteCtx) => Promise<Decision>
	retractVote: (pollId: string, ctx: VoteCtx) => Promise<Decision>
	closePoll: (pollId: string, ctx: AdminCtx) => Promise<Decision>
	getResults: (pollId: string, now: number) => Promise<ResultsSnapshot | null>
	mutateBatch?: (pollId: string, reqs: BatchReq[]) => Promise<Decision[]>
	dispose?: () => void | Promise<void>
}

export abstract class PollKernel extends BasePlugin implements PollKernelDriver {
	private driverPromise: Promise<PollKernelDriver> | undefined
	private shuttingDown = false

	protected abstract createDriver(): PollKernelDriver | Promise<PollKernelDriver>

	protected async driver(): Promise<PollKernelDriver> {
		if (this.shuttingDown) throw new Error('[PollKernel] driver is shutting down')
		this.driverPromise ??= Promise.resolve(this.createDriver())
		return await this.driverPromise
	}

	override async stop(_abort: AbortSignal): Promise<void> {
		this.shuttingDown = true
		const promise = this.driverPromise
		this.driverPromise = undefined
		if (promise) {
			try {
				const driver = await promise
				await driver.dispose?.()
			} catch {
				// best-effort cleanup
			}
		}
		await super.stop(_abort)
	}

	async createPoll(spec: PollSpec, ctx: AdminCtx): Promise<{ pollId: string }> {
		return await (await this.driver()).createPoll(spec, ctx)
	}

	async castVote(pollId: string, selection: SelectionInput, ctx: VoteCtx): Promise<Decision> {
		return await (await this.driver()).castVote(pollId, selection, ctx)
	}

	async retractVote(pollId: string, ctx: VoteCtx): Promise<Decision> {
		return await (await this.driver()).retractVote(pollId, ctx)
	}

	async closePoll(pollId: string, ctx: AdminCtx): Promise<Decision> {
		return await (await this.driver()).closePoll(pollId, ctx)
	}

	async getResults(pollId: string, now: number): Promise<ResultsSnapshot | null> {
		return await (await this.driver()).getResults(pollId, now)
	}

	async mutateBatch(pollId: string, reqs: BatchReq[]): Promise<Decision[]> {
		const driver = await this.driver()
		if (!driver.mutateBatch) {
			throw new Error('[PollKernel] mutateBatch is not supported by driver')
		}
		return await driver.mutateBatch(pollId, reqs)
	}
}
