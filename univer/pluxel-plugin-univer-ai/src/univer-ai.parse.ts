import type { UniverAiChange, UniverAiChangeSet } from './univer-ai.types'

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseRange(value: unknown): UniverAiChange['range'] | null {
	if (!isRecord(value)) return null
	const startRowRaw = value.startRow
	const startColRaw = value.startCol
	const endRowRaw = value.endRow
	const endColRaw = value.endCol
	if (![startRowRaw, startColRaw, endRowRaw, endColRaw].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
	return {
		startRow: startRowRaw as number,
		startCol: startColRaw as number,
		endRow: endRowRaw as number,
		endCol: endColRaw as number,
	}
}

function parseChange(value: unknown): UniverAiChange | null {
	if (!isRecord(value)) return null
	const id = value.id
	const op = value.op
	const range = parseRange(value.range)
	if (typeof id !== 'string' || !id) return null
	if (op !== 'setValues' && op !== 'clear') return null
	if (!range) return null
	const sheetId = typeof value.sheetId === 'string' ? value.sheetId : undefined
	const reason = typeof value.reason === 'string' ? value.reason : undefined
	const expectedOld = value.expectedOld

	if (op === 'setValues') {
		const val = value.value
		if (!Array.isArray(val)) return null
		return { id, op, sheetId, range, value: val, expectedOld, reason }
	}

	return { id, op, sheetId, range, expectedOld, reason }
}

export function parseChangeSetJsonText(args: {
	workbookId: string
	createdAt: number
	id: string
	model?: string
	text: string
}): UniverAiChangeSet {
	let obj: unknown
	try {
		obj = JSON.parse(args.text)
	} catch (error) {
		throw new Error(`AI output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
	}

	if (!isRecord(obj)) throw new Error('AI output must be a JSON object')
	const summary = typeof obj.summary === 'string' ? obj.summary : undefined
	const changesRaw = obj.changes
	if (!Array.isArray(changesRaw)) throw new Error('AI output: "changes" must be an array')

	const changes: UniverAiChange[] = []
	for (const item of changesRaw) {
		const parsed = parseChange(item)
		if (parsed) changes.push(parsed)
	}

	return {
		id: args.id,
		workbookId: args.workbookId,
		createdAt: args.createdAt,
		model: args.model,
		summary,
		changes,
	}
}
