import type {
	UniverAiChangeSet,
	UniverAiSuggestEditsInput,
	UniverAiSuggestEditsResult,
} from 'pluxel-plugin-univer-ai'

export type UniverAiWireContext = {
	format: 'toon'
	contentType: 'text/plain'
	text: string
}

export type UniverAiContextHint = {
	sheetId?: string | null
	range: { startRow: number; startCol: number; endRow: number; endCol: number }
	a1?: string
}

export type UniverAiSuggestInput = {
	workbookId: string
	instruction: string
	context: UniverAiWireContext
	contextHint: UniverAiContextHint
}

export type UniverAiSuggestResult = {
	changeSet: UniverAiChangeSet | null
	meta?: UniverAiSuggestEditsResult['meta'] | null
}

export type UniverAiDecisionAction = 'apply' | 'undo' | 'preview' | 'reject'

export type UniverAiDecision = {
	workbookId: string
	changeId: string
	action: UniverAiDecisionAction
	op: string
	range: { startRow: number; startCol: number; endRow: number; endCol: number }
	sheetId?: string | null
	reason?: string | null
}

export type UniverAiFrontendApi = {
	suggestEdits(input: UniverAiSuggestInput): Promise<UniverAiSuggestResult>
	reportDecision?(input: UniverAiDecision): Promise<void> | void
}

export function adaptUniverAiRpc(
	rpc: { suggestEdits(input: UniverAiSuggestEditsInput): Promise<UniverAiSuggestEditsResult> } | null,
): UniverAiFrontendApi | null {
	if (!rpc) return null
	return {
		suggestEdits: async (input) => rpc.suggestEdits(input as UniverAiSuggestEditsInput),
		reportDecision: async (input) => {
			const anyRpc = rpc as { reportDecision?: (payload: UniverAiDecision) => Promise<void> | void }
			if (typeof anyRpc.reportDecision === 'function') {
				await anyRpc.reportDecision(input)
			}
		},
	}
}
