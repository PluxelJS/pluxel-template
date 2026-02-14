import { clampInt } from './limits'

function truncateText(input: unknown, maxChars: number) {
	const s = String(input ?? '')
	if (s.length <= maxChars) return s
	return `${s.slice(0, Math.max(0, maxChars - 1))}…`
}

function summarizeMatrix(input: unknown, maxSampleRows = 2, maxSampleCols = 6) {
	if (!Array.isArray(input)) return input
	const rows = input.length
	const cols = Math.max(0, ...input.map((r) => (Array.isArray(r) ? r.length : 0)))
	const sample: string[][] = []
	for (let r = 0; r < Math.min(rows, maxSampleRows); r++) {
		const row = Array.isArray(input[r]) ? (input[r] as unknown[]) : []
		const cells: string[] = []
		for (let c = 0; c < Math.min(row.length, maxSampleCols); c++) {
			cells.push(truncateText(row[c], 48))
		}
		sample.push(cells)
	}
	return { rows, cols, sample }
}

export function sanitizeToolPayload(input: unknown) {
	if (!input || typeof input !== 'object') return input
	const obj = input as Record<string, unknown>
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(obj)) {
		if (k === 'readback') {
			if (v && typeof v === 'object' && !Array.isArray(v)) {
				const rb = v as Record<string, unknown>
				// get_ranges_data-like payload: { order, byA1 }
				if (rb.byA1 && typeof rb.byA1 === 'object' && !Array.isArray(rb.byA1)) {
					const keys = Object.keys(rb.byA1 as Record<string, unknown>)
					out[k] = {
						orderCount: Array.isArray(rb.order) ? rb.order.length : undefined,
						byA1: { count: keys.length, head: keys.slice(0, 6) },
					}
					continue
				}
				// get_range_data-like payload
				if (typeof rb.a1 === 'string' && Array.isArray(rb.values)) {
					out[k] = { a1: rb.a1, values: summarizeMatrix(rb.values), displayValues: summarizeMatrix(rb.displayValues) }
					continue
				}
			}
			out[k] = v
			continue
		}
		if (k === 'values') {
			out[k] = summarizeMatrix(v)
			continue
		}
		if (k === 'displayValues') {
			out[k] = summarizeMatrix(v)
			continue
		}
		if (k === 'ops' && Array.isArray(v)) {
			const head = v.slice(0, 3).map((x) => (typeof x === 'object' && x ? { ...(x as Record<string, unknown>) } : x))
			out[k] = { count: v.length, head }
			continue
		}
		if (k === 'matches' && Array.isArray(v)) {
			out[k] = { count: v.length, head: v.slice(0, 5) }
			continue
		}
		if ((k === 'ranges' || k === 'items') && Array.isArray(v)) {
			out[k] = { count: v.length, head: v.slice(0, 5) }
			continue
		}
		if (k === 'updates' && Array.isArray(v)) {
			const head = v.slice(0, 3).map((x) => {
				if (!x || typeof x !== 'object') return x
				const y = { ...(x as Record<string, unknown>) } as Record<string, unknown>
				if ('values' in y) y.values = summarizeMatrix(y.values)
				return y
			})
			out[k] = { count: v.length, head }
			continue
		}
		if (k === 'byA1' && v && typeof v === 'object' && !Array.isArray(v)) {
			const keys = Object.keys(v as Record<string, unknown>)
			out[k] = { count: keys.length, head: keys.slice(0, 6) }
			continue
		}
		if (typeof v === 'string') {
			out[k] = truncateText(v, 400)
			continue
		}
		out[k] = v
	}
	return out
}

function escapeCellText(input: string, maxChars: number) {
	const s = String(input ?? '').replace(/\r?\n/g, ' ').trim()
	if (s.length <= maxChars) return s
	return `${s.slice(0, Math.max(0, maxChars - 1))}…`
}

export function matrixPreviewTSV(values: string[][], opts?: { maxRows?: number; maxCols?: number; maxCellChars?: number }): string {
	const maxRows = clampInt(opts?.maxRows, 1, 50)
	const maxCols = clampInt(opts?.maxCols, 1, 50)
	const maxCellChars = clampInt(opts?.maxCellChars, 8, 120)

	const out: string[] = []
	const rowCount = values.length
	for (let r = 0; r < Math.min(rowCount, maxRows); r++) {
		const row = values[r] ?? []
		const cells: string[] = []
		for (let c = 0; c < Math.min(row.length, maxCols); c++) {
			cells.push(escapeCellText(String(row[c] ?? ''), maxCellChars))
		}
		out.push(cells.join('\t'))
	}
	return out.join('\n')
}

export { truncateText }
