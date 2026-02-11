import type { UniverAiContractLimits } from './ai'
import type { UniverToolPolicy } from './tools'

export type UniverLoopbackScopes = Readonly<{
	read: readonly string[]
	write?: readonly string[]
	current?: string
}>

export type UniverLoopbackRunInput = Readonly<{
	workbookId: string
	baseRev?: number
	instruction: string
	scopes: UniverLoopbackScopes
	maxRounds?: number
	mode?: 'safe' | 'aggressive'
	llmProfileId?: string
	toolPolicy?: UniverToolPolicy
	limits?: { maxRows?: number; maxCols?: number }
	contract?: UniverAiContractLimits
}>

export type UniverLoopbackConflict = Readonly<{
	currentRev: number
	snapshotUrl: string | null
	etag: string | null
}>

export type UniverLoopbackRunResult = Readonly<
	| {
			ok: true
			baseRev: number
			newRev: number
			snapshotUrl: string
			etag: string
			rounds: number
			appliedOps: number
			summary?: string
	  }
	| {
			ok: false
			error: string
			conflict?: UniverLoopbackConflict
	  }
>
