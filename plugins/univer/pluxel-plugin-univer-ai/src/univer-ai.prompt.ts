import type { UniverAiSuggestEditsInput } from './univer-ai.types'

export function buildSuggestEditsPrompt(input: UniverAiSuggestEditsInput, contextToonText: string): string {
	const mode = input.mode ?? 'safe'
	return [
		'You are an assistant that proposes spreadsheet edits as a ChangeSet.',
		'Constraints:',
		'- Output MUST be valid JSON only (no markdown, no comments).',
		'- Do NOT invent sheetId; use the provided sheetId when present.',
		'- Prefer conservative changes in safe mode.',
		'Output schema (JSON):',
		'{',
		'  "summary": string,',
		'  "changes": Array<{',
		'    "id": string,',
		'    "sheetId"?: string,',
		'    "range": { "startRow": number, "startCol": number, "endRow": number, "endCol": number },',
		'    "op": "setValues" | "clear",',
		'    "value"?: unknown,',
		'    "expectedOld"?: unknown,',
		'    "reason"?: string',
		'  }>',
		'}',
		'Notes:',
		'- Rows/cols are 0-based indexes.',
		'- For op="setValues", value MUST be a 2D array sized to the range.',
		'- For op="clear", omit value.',
		'---',
		`MODE: ${mode}`,
		`WORKBOOK_ID: ${input.workbookId}`,
		input.contextHint?.sheetId ? `SHEET_ID: ${input.contextHint.sheetId}` : 'SHEET_ID: (unknown)',
		input.contextHint?.a1 ? `A1: ${input.contextHint.a1}` : '',
		'---',
		'INSTRUCTION:',
		input.instruction.trim(),
		'---',
		'TABLE_CONTEXT (TOON):',
		contextToonText,
	].filter(Boolean).join('\n')
}

