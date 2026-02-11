export type UniverRangeLike = {
	startRow: number
	startCol: number
	endRow: number
	endCol: number
}

function shouldQuoteSheetName(name: string) {
	return !/^[A-Za-z0-9_]+$/.test(name)
}

export function formatSheetNameForA1(name: string) {
	const raw = String(name ?? '').trim()
	if (!raw) return ''
	if (!shouldQuoteSheetName(raw)) return raw
	return `'${raw.replace(/'/g, "''")}'`
}

export function colToA1Letters(col0: number) {
	let n = Math.max(0, Math.floor(col0)) + 1
	let letters = ''
	while (n > 0) {
		const rem = (n - 1) % 26
		letters = String.fromCharCode(65 + rem) + letters
		n = Math.floor((n - 1) / 26)
	}
	return letters
}

export function cellToA1(row0: number, col0: number) {
	return `${colToA1Letters(col0)}${Math.max(0, Math.floor(row0)) + 1}`
}

export function rangeToA1(range: UniverRangeLike) {
	const start = cellToA1(range.startRow, range.startCol)
	const end = cellToA1(range.endRow, range.endCol)
	return start === end ? start : `${start}:${end}`
}
