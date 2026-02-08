import type { UniverAiChange } from 'pluxel-plugin-univer-ai'

export type PreparedAiCellDiff = {
	row: number
	col: number
	oldValue: string
	nextValue: string
}

export type PreparedAiChange = {
	id: string
	op: UniverAiChange['op']
	sheetId: string | null
	range: { startRow: number; startCol: number; endRow: number; endCol: number }
	reason: string | null
	oldMatrix: string[][]
	nextMatrix: string[][] | null
	diffCells: number
	cellDiffs: PreparedAiCellDiff[]
}

function as2dArray(value: unknown): unknown[][] | null {
	if (!Array.isArray(value)) return null
	if (!value.every(Array.isArray)) return null
	return value as unknown[][]
}

export function normalizeMatrix(matrix: unknown[][] | null | undefined, rows: number, cols: number) {
	const next: string[][] = []
	for (let r = 0; r < rows; r++) {
		const rawRow = matrix?.[r]
		const rowValues = Array.isArray(rawRow) ? rawRow : []
		const row: string[] = []
		for (let c = 0; c < cols; c++) {
			row.push(String(rowValues[c] ?? ''))
		}
		next.push(row)
	}
	return next
}

export function computePreparedChange(input: {
	change: UniverAiChange
	oldDisplayValues: unknown
}): PreparedAiChange {
	const { change, oldDisplayValues } = input
	const rows = change.range.endRow - change.range.startRow + 1
	const cols = change.range.endCol - change.range.startCol + 1

	const oldMatrix = normalizeMatrix(as2dArray(oldDisplayValues), rows, cols)

	const nextMatrix =
		change.op === 'clear'
			? null
			: normalizeMatrix(as2dArray(change.value), rows, cols)

	const cellDiffs: PreparedAiCellDiff[] = []
	let diffCells = 0
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const oldValue = String(oldMatrix[r]?.[c] ?? '')
			const nextValue = nextMatrix ? String(nextMatrix[r]?.[c] ?? '') : ''
			const changed = change.op === 'clear' ? true : oldValue !== nextValue
			if (!changed) continue
			diffCells++
			cellDiffs.push({
				row: change.range.startRow + r,
				col: change.range.startCol + c,
				oldValue,
				nextValue,
			})
		}
	}

	return {
		id: change.id,
		op: change.op,
		sheetId: change.sheetId ?? null,
		range: change.range,
		reason: typeof change.reason === 'string' ? change.reason : null,
		oldMatrix,
		nextMatrix,
		diffCells,
		cellDiffs,
	}
}

export function cellKey(sheetId: string, row: number, col: number) {
	return `${sheetId}:${row}:${col}`
}
