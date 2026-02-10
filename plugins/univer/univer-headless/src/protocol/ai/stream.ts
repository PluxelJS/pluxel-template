import type { UniverAiLlmProfile } from './types'

/**
 * SSE namespace for Univer AI session/job events.
 *
 * This is intentionally *append-only* (offset-based) to allow cheap reconnect + replay,
 * similar to an "offset log" / "durable stream" abstraction.
 */
export const UNIVER_AI_SSE_NS = 'univer:ai' as const

export type UniverAiThreadEvent =
	| {
			type: 'request'
			at: number
			requestId: string
			workbookId: string
			instruction: string
			contextHint?: { sheetId?: string; a1?: string }
	  }
	| {
			type: 'status'
			at: number
			requestId: string
			stage:
				| 'start'
				| 'connecting'
				| 'generating'
				| 'validating'
				| 'retrying'
				| 'done'
				| 'failed'
			message?: string
	  }
	| {
			type: 'result'
			at: number
			requestId: string
			changeSetId: string
			summary?: string
			changes: number
			ops: number
			llmProfile: UniverAiLlmProfile
			traceId?: string
			threadId?: string
	  }
	| {
			type: 'error'
			at: number
			requestId: string
			error: string
	  }

export type UniverAiThreadEventEnvelope = {
	schema: 1
	threadId: string
	offset: number
	event: UniverAiThreadEvent
}

export type UniverAiThreadSnapshot = {
	schema: 1
	threadId: string
	/** Inclusive offset of the first cached event. */
	baseOffset: number
	/** Next offset to be assigned (exclusive upper bound). */
	nextOffset: number
	/** Cached events (may be truncated). */
	events: UniverAiThreadEventEnvelope[]
}
