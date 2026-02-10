export type UniverAiRange = {
	startRow: number
	startCol: number
	endRow: number
	endCol: number
}

export type UniverAiWriteScope = {
	/**
	 * Stable id referenced by AI output as `scopeId`.
	 *
	 * Recommended: reuse `selections[*].id` for normal selection writes; use a different id
	 * when allowing write outside the read selections (e.g. "fill down").
	 */
	id: string
	sheetId: string
	range: UniverAiRange
	a1?: string
	label?: string
}

export type UniverAiEditContract = {
	schema: 1
	/**
	 * Where the model is allowed to write cell values.
	 *
	 * This is the *single source of truth* for output validation: the backend MUST reject any edit
	 * outside these scopes; the UI MAY still do best-effort checks.
	 */
	writeScopes: UniverAiWriteScope[]
	limits?: {
		maxChanges?: number
		maxOps?: number
	}
}

export const UNIVER_AI_DEFAULT_CONTRACT_LIMITS = {
	maxChanges: 24,
	maxOps: 4000,
} as const

export type UniverAiContext = {
	workbookId: string
	sheetId?: string
	range?: UniverAiRange
	a1?: string
	/**
	 * Display values (already formatted for humans).
	 * Usually sized to the range (or truncated by the UI).
	 */
	displayValues?: string[][]
	/**
	 * Optional raw values (numbers/strings/bools/null).
	 * Prefer `displayValues` when possible to keep the prompt stable.
	 */
	values?: unknown[][]
	meta?: Record<string, unknown>
}

export type UniverAiStructuredContext = {
	format: 'toon'
	contentType: string
	text: string
}

export type UniverAiSuggestEditsInput = {
	workbookId: string
	instruction: string
	context: UniverAiStructuredContext
	mode?: 'safe' | 'aggressive'
	contextHint?: { sheetId?: string; range?: UniverAiRange; a1?: string }
	/**
	 * Optional: select an LLM profile explicitly (LLMHub profile id).
	 * When omitted, the backend may fall back to any enabled profile.
	 */
	llmProfileId?: string
	/**
	 * Optional: conversation/thread id for upstream correlation.
	 * When omitted, defaults to workbookId.
	 */
	threadId?: string
}

export type UniverAiChangeOp = 'setValues' | 'clear'

export type UniverAiCellValue = string

export type UniverAiOpsV1 =
	| { op: 'set'; row: number; col: number; value: UniverAiCellValue }
	| { op: 'clear'; row: number; col: number }

export type UniverAiSetValuesOpsPayloadV1 = {
	kind: 'ops-v1'
	ops: UniverAiOpsV1[]
}

export type UniverAiChangeBase = {
	id: string
	/**
	 * Must reference one of `TABLE_CONTEXT.contract.writeScopes[*].id` (TOON input).
	 *
	 * The range/sheetId are resolved from the scope, so the model does not need to repeat them.
	 */
	scopeId: string
	op: UniverAiChangeOp
	reason?: string
}

export type UniverAiChange =
	| (UniverAiChangeBase & { op: 'clear' })
	| (UniverAiChangeBase & {
			op: 'setValues'
			/**
			 * For `setValues`: an ops payload (kind="ops-v1") with absolute row/col.
			 */
			value: UniverAiSetValuesOpsPayloadV1
	  })

export type UniverAiChangeSet = {
	id: string
	workbookId: string
	createdAt: number
	model?: string
	summary?: string
	changes: UniverAiChange[]
}

export type UniverAiLlmProfile = {
	id: string
	provider: string
	model?: string
	baseURL?: string
}

export type UniverAiSuggestEditsMeta = {
	llmProfile: UniverAiLlmProfile
	/** Request correlation id (propagated as x-pluxel-trace-id). */
	traceId?: string
	/** Conversation/session id (propagated as x-pluxel-session-id). */
	threadId?: string
}

export type UniverAiSuggestEditsResult = {
	changeSet: UniverAiChangeSet
	meta?: UniverAiSuggestEditsMeta
}

export type UniverAiCapability = {
	available: boolean
	defaultProfile?: UniverAiLlmProfile
	reason?: string
}

export type UniverAiSelectionContext = {
	kind: 'pluxel.univer.selectionContext'
	schema: 2
	workbookId: string
	currentId: string
	selections: UniverAiSelection[]
	contract: UniverAiEditContract
}

export type UniverAiSelection = {
	id: string
	sheetId: string | null
	a1: string
	range: UniverAiRange
	values: string[][]
	truncated?: boolean
	orig?: { startRow: number; startCol: number; endRow: number; endCol: number; rows: number; cols: number }
	limits?: { maxRows: number; maxCols: number }
}
