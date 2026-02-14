import type { UniverRange } from '../../protocol'

import { formatA1Range } from '../a1'
import { toMatrix } from './utils'

type NormalizedWrite = Readonly<{
	range: UniverRange
	values: unknown[][]
	updatedCells: number
	warning?: string
}>

function isEmptyCellValue(v: unknown): boolean {
	if (v == null) return true
	if (typeof v === 'string') return v.trim() === ''
	return false
}

function computeRangeSize(range: UniverRange) {
	return {
		rows: Math.max(0, range.endRow - range.startRow + 1),
		cols: Math.max(0, range.endCol - range.startCol + 1),
	}
}

function canTrimToSize(values: unknown[][], expectedRows: number, expectedCols: number): boolean {
	for (let r = 0; r < values.length; r++) {
		const row = values[r] ?? []
		for (let c = 0; c < row.length; c++) {
			const inBounds = r < expectedRows && c < expectedCols
			if (inBounds) continue
			if (!isEmptyCellValue(row[c])) return false
		}
	}
	return true
}

function trimToSize(values: unknown[][], expectedRows: number, expectedCols: number): unknown[][] {
	const out: unknown[][] = []
	for (let r = 0; r < Math.min(values.length, expectedRows); r++) {
		const row = values[r] ?? []
		out.push(row.slice(0, expectedCols))
	}
	return out
}

function shrinkRangeTopLeft(range: UniverRange, rows: number, cols: number): UniverRange {
	return {
		startRow: range.startRow,
		startCol: range.startCol,
		endRow: range.startRow + Math.max(0, Math.floor(rows)) - 1,
		endCol: range.startCol + Math.max(0, Math.floor(cols)) - 1,
	}
}

function isDense(values: unknown[][], cols: number) {
	return values.every((r) => Array.isArray(r) && r.length === cols)
}

/**
 * Univer's Range#setValues requires a dense matrix whose shape matches the target range.
 *
 * This normalizer is intentionally tolerant to common LLM mistakes:
 * - extra trailing empty rows/cols -> trims
 * - single scalar -> tiles (except scalar formulas)
 * - smaller dense matrix -> shrinks the written range to the top-left subrange and emits a warning
 *
 * It still rejects truly ambiguous / lossy cases (ragged rows, larger non-empty overflow, empty matrix).
 */
export function normalizeWriteMatrixForRange(inputValues: unknown, requestedRange: UniverRange, sheetNameForA1: string): NormalizedWrite {
	if (!Array.isArray(inputValues)) throw new Error('[univer] set_range_data invalid values: expected a 2D array (matrix)')

	let values = toMatrix(inputValues)
	const { rows: expectedRows, cols: expectedCols } = computeRangeSize(requestedRange)
	const expected = `${expectedRows}x${expectedCols}`
	if (!expectedRows || !expectedCols) return { range: requestedRange, values: [], updatedCells: 0 }

	const gotRows = values.length
	const gotCols = Math.max(0, ...values.map((r) => (Array.isArray(r) ? r.length : 0)))
	const got = `${gotRows}x${gotCols}`

	// Exact match (dense)
	if (gotRows === expectedRows && gotCols === expectedCols && isDense(values, expectedCols)) {
		return { range: requestedRange, values, updatedCells: expectedRows * expectedCols }
	}

	// Trim (only when overflow is empty).
	if (gotRows >= expectedRows && gotCols >= expectedCols && canTrimToSize(values, expectedRows, expectedCols)) {
		values = trimToSize(values, expectedRows, expectedCols)
		if (values.length === expectedRows && isDense(values, expectedCols)) {
			return {
				range: requestedRange,
				values,
				updatedCells: expectedRows * expectedCols,
				warning: `[univer] set_range_data normalized values: trimmed to ${expected}.`,
			}
		}
	}

	// Tile a single scalar value across the whole target (common for constants).
	if (gotRows === 1 && gotCols === 1) {
		const v = values[0]?.[0]
		if (typeof v === 'string' && v.trim().startsWith('=') && expectedRows * expectedCols > 1) {
			throw new Error(
				`[univer] set_range_data invalid values matrix: got ${got} but expected ${expected}. For formulas, provide a full ${expected} matrix (each cell can have its own formula string).`,
			)
		}
		values = Array.from({ length: expectedRows }, () => Array.from({ length: expectedCols }, () => v))
		return {
			range: requestedRange,
			values,
			updatedCells: expectedRows * expectedCols,
			warning: `[univer] set_range_data normalized values: tiled scalar to ${expected}.`,
		}
	}

	// If the matrix is smaller but dense, shrink the write range to match.
	// This keeps the untouched cells intact and avoids hard failures.
	if (gotRows > 0 && gotCols > 0 && gotRows <= expectedRows && gotCols <= expectedCols && isDense(values, gotCols)) {
		const writtenRange = shrinkRangeTopLeft(requestedRange, gotRows, gotCols)
		const writtenA1 = formatA1Range(sheetNameForA1, writtenRange)
		const requestedA1 = formatA1Range(sheetNameForA1, requestedRange)
		return {
			range: writtenRange,
			values,
			updatedCells: gotRows * gotCols,
			warning: `[univer] set_range_data normalized values: got ${got} but expected ${expected}; wrote top-left subrange only (${writtenA1}) instead of requested (${requestedA1}). Provide a full ${expected} matrix if you intended to write the entire range.`,
		}
	}

	// Suggest an A1 if the user actually intended a smaller write.
	const suggestedA1 = (() => {
		if (!gotRows || !gotCols) return null
		const next = shrinkRangeTopLeft(requestedRange, gotRows, gotCols)
		return formatA1Range(sheetNameForA1, next)
	})()

	throw new Error(
		`[univer] set_range_data invalid values matrix: got ${got} but expected ${expected}. A1 ranges are inclusive; double-check off-by-one and avoid accidental header/total rows. ${
			suggestedA1 ? `If you intended to write a ${got} matrix, use a1=${suggestedA1}.` : ''
		}`.trim(),
	)
}

