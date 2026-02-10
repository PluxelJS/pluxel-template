export type UniverLoopbackRunInput = Readonly<{
	workbookId: string
	/** When omitted, uses latestRev. */
	baseRev?: number
	instruction: string
	/** Read scopes (A1). Must be non-empty. */
	read: readonly string[]
	/** Write scopes (A1). When omitted, defaults to `read`. */
	write?: readonly string[]
	/** Current/primary scope (A1). Defaults to first `read`. */
	current?: string
	/** Max agent rounds (default: 4). */
	maxRounds?: number
	mode?: 'safe' | 'aggressive'
	llmProfileId?: string
	limits?: { maxRows?: number; maxCols?: number }
	contractLimits?: { maxOps?: number; maxChanges?: number }
}>

export type UniverLoopbackRunResult = Readonly<
	| {
			ok: true
			baseRev: number
			newRev: number
			newSnapshotUrl: string
			newEtag: string
			rounds: number
			appliedOps: number
			summary?: string
	  }
	| {
			ok: false
			error: string
			/** Conflict when baseRev doesn't match latestRev. */
			conflict?: { currentRev: number; latestSnapshotUrl: string | null; latestEtag: string | null }
	  }
>
