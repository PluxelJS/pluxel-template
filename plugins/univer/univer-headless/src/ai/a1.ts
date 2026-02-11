import type { UniverRange } from '../protocol'

export type A1RangeParsed = {
	sheetName?: string
	range: UniverRange
	a1: string
}

function shouldQuoteSheetName(name: string) {
	// Keep it conservative: quote whenever it contains characters that commonly break A1 parsing.
	// This matches common spreadsheet behavior and prevents "Sheet 1!A1" style ambiguities.
	return !/^[A-Za-z0-9_]+$/.test(name)
}

export function formatSheetNameForA1(name: string) {
	const raw = String(name ?? '').trim()
	if (!raw) return ''
	if (!shouldQuoteSheetName(raw)) return raw
	// Spreadsheet single-quote escaping: ' -> ''
	return `'${raw.replace(/'/g, "''")}'`
}

export function formatA1Range(sheetName: string | undefined, range: UniverRange) {
	const start = cellToA1(range.startRow, range.startCol)
	const end = cellToA1(range.endRow, range.endCol)
	const base = start === end ? start : `${start}:${end}`
	if (!sheetName) return base
	return `${formatSheetNameForA1(sheetName)}!${base}`
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

	let sheetName: string | undefined
	let rangePart = s
	if (s.includes('!')) {
		if (s.startsWith("'")) {
			// Parse "'Sheet 1'!A1:B2" where single quotes can be escaped by doubling: "''".
			let i = 1
			let name = ''
			while (i < s.length) {
				const ch = s[i]!
				if (ch === "'") {
					const next = s[i + 1]
					if (next === "'") {
						name += "'"
						i += 2
						continue
					}
					// Closing quote; next must be !
					if (s[i + 1] !== '!') break
					sheetName = name
					rangePart = s.slice(i + 2)
					break
				}
				name += ch
				i++
			}
			if (sheetName === undefined) {
				// Fall back to naive split to produce a useful error downstream.
				const parts = s.split('!')
				sheetName = parts[0] ? String(parts[0]).replace(/^'+|'+$/g, '').trim() : undefined
				rangePart = parts.slice(1).join('!')
			}
		} else {
			const idx = s.indexOf('!')
			sheetName = String(s.slice(0, idx)).trim() || undefined
			rangePart = s.slice(idx + 1)
		}
	}
	const r = String(rangePart ?? '').trim()
	const cells = r.split(':').map((x) => x.trim())
	if (cells.length === 1) {
		const c = parseA1Cell(cells[0]!)
		const range = { startRow: c.row, startCol: c.col, endRow: c.row, endCol: c.col }
		return { sheetName, a1: formatA1Range(sheetName, range), range }
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
	return { sheetName, a1: formatA1Range(sheetName, range), range }
}
