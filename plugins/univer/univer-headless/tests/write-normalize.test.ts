import { describe, expect, it } from 'vitest'

import { normalizeWriteMatrixForRange } from '../src/ai/mcp/write-normalize'

describe('univer-headless: set_range_data matrix normalization', () => {
	it('shrinks range when matrix is smaller (rows)', () => {
		const res = normalizeWriteMatrixForRange(
			Array.from({ length: 9 }, () => Array.from({ length: 6 }, () => 'x')),
			{ startRow: 0, startCol: 0, endRow: 9, endCol: 5 }, // 10x6
			'Sheet1',
		)
		expect(res.updatedCells).toBe(54)
		expect(res.range).toEqual({ startRow: 0, startCol: 0, endRow: 8, endCol: 5 }) // 9x6
		expect(res.warning).toContain('wrote top-left subrange only')
	})

	it('shrinks range when matrix is smaller (cols)', () => {
		const res = normalizeWriteMatrixForRange(
			Array.from({ length: 10 }, () => Array.from({ length: 3 }, () => 'x')),
			{ startRow: 0, startCol: 0, endRow: 9, endCol: 5 }, // 10x6
			'Sheet1',
		)
		expect(res.updatedCells).toBe(30)
		expect(res.range).toEqual({ startRow: 0, startCol: 0, endRow: 9, endCol: 2 }) // 10x3
		expect(res.warning).toContain('wrote top-left subrange only')
	})

	it('tiles a scalar constant', () => {
		const res = normalizeWriteMatrixForRange([[42]], { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, 'Sheet1')
		expect(res.updatedCells).toBe(4)
		expect(res.values).toEqual([
			[42, 42],
			[42, 42],
		])
		expect(res.warning).toContain('tiled scalar')
	})

	it('rejects scalar formulas for multi-cell ranges', () => {
		expect(() =>
			normalizeWriteMatrixForRange([['=A1+1']], { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, 'Sheet1'),
		).toThrow(/provide a full 2x2 matrix/i)
	})
})

