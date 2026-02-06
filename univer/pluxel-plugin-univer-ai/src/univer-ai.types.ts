export type UniverAiRange = {
	startRow: number
	startCol: number
	endRow: number
	endCol: number
}

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
	format: 'json' | 'toon'
	contentType: string
	text: string
}

export type UniverAiSuggestEditsInput = {
	workbookId: string
	instruction: string
	context: UniverAiStructuredContext
	mode?: 'safe' | 'aggressive'
	contextHint?: { sheetId?: string; range?: UniverAiRange; a1?: string }
}

export type UniverAiChangeOp = 'setValues' | 'clear'

export type UniverAiChange = {
	id: string
	sheetId?: string
	range: UniverAiRange
	op: UniverAiChangeOp
	/**
	 * For `setValues`: a 2D matrix sized to the range.
	 * For `clear`: omitted.
	 */
	value?: unknown
	expectedOld?: unknown
	reason?: string
}

export type UniverAiChangeSet = {
	id: string
	workbookId: string
	createdAt: number
	model?: string
	summary?: string
	changes: UniverAiChange[]
}

export type UniverAiSuggestEditsResult = { changeSet: UniverAiChangeSet }

