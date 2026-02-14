import type { UniverAiContext } from './ai'

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
	/**
	 * Optional frontend-provided selection previews to reduce initial read tool calls.
	 * Typically contains current selection + pinned selections (already clipped).
	 */
	contexts?: Readonly<{ selections: readonly UniverAiContext[] }>
	llmProfileId?: string
}>

export type UniverLoopbackConflict = Readonly<{
	currentRev: number
	snapshotUrl: string | null
	etag: string | null
}>

export type UniverLoopbackDebug = Readonly<{
	rounds?: number
	toolCalls?: number
	readCalls?: number
	toolErrors?: number
	lastReadTool?: string
	lastWriteTool?: string
	lastVerifyTool?: string
	lastErrorTool?: string
	lastReadSeq?: number
	lastWriteSeq?: number
	lastVerifySeq?: number
	lastErrorSeq?: number
}>

export type UniverLoopbackRunResult = Readonly<
	| {
			ok: true
			runId?: string
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
			runId?: string
			error: string
			conflict?: UniverLoopbackConflict
			debug?: UniverLoopbackDebug
	  }
>
