import type { UniverAiRange } from '../protocol'

export type A1RangeParsed = {
	sheetName?: string
	range: UniverAiRange
	a1: string
}

function colToIndex(letters: string) {
	let n = 0
	for (const ch of letters.toUpperCase()) {
		if (ch < 'A' || ch > 'Z') throw new Error(`[univer] invalid column letters: ${letters}`)
		n = n * 26 + (ch.charCodeAt(0) - 64)
	}
	return n - 1
}

function indexToCol(col: number) {
	if (!Number.isFinite(col) || col < 0) throw new Error(`[univer] invalid column index: ${col}`)
	let n = Math.floor(col) + 1
	let out = ''
	while (n > 0) {
		const rem = (n - 1) % 26
		out = String.fromCharCode(65 + rem) + out
		n = Math.floor((n - 1) / 26)
	}
	return out
}

export function cellToA1(row: number, col: number) {
	if (!Number.isFinite(row) || row < 0) throw new Error(`[univer] invalid row index: ${row}`)
	return `${indexToCol(col)}${Math.floor(row) + 1}`
}

function parseA1Cell(text: string) {
	const m = text.trim().match(/^([A-Za-z]+)(\d+)$/)
	if (!m) throw new Error(`[univer] invalid A1 cell: ${text}`)
	const col = colToIndex(m[1]!)
	const row = Number(m[2]!) - 1
	if (!Number.isFinite(row) || row < 0) throw new Error(`[univer] invalid A1 cell: ${text}`)
	return { row, col }
}

export function parseA1Range(input: string): A1RangeParsed {
	const s = String(input ?? '').trim()
	if (!s) throw new Error('[univer] A1 range must be non-empty')

	const [sheetPart, rangePart] = s.includes('!') ? (s.split('!') as [string, string]) : [undefined, s]
	const sheetName = sheetPart ? String(sheetPart).trim() : undefined
	const r = String(rangePart ?? '').trim()
	const cells = r.split(':').map((x) => x.trim())
	if (cells.length === 1) {
		const c = parseA1Cell(cells[0]!)
		return {
			sheetName,
			a1: sheetName ? `${sheetName}!${cells[0]}` : cells[0]!,
			range: { startRow: c.row, startCol: c.col, endRow: c.row, endCol: c.col },
		}
	}
	if (cells.length !== 2) throw new Error(`[univer] invalid A1 range: ${input}`)
	const a = parseA1Cell(cells[0]!)
	const b = parseA1Cell(cells[1]!)
	const range = {
		startRow: Math.min(a.row, b.row),
		startCol: Math.min(a.col, b.col),
		endRow: Math.max(a.row, b.row),
		endCol: Math.max(a.col, b.col),
	}
	const short = `${cells[0]}:${cells[1]}`
	return { sheetName, a1: sheetName ? `${sheetName}!${short}` : short, range }
}
