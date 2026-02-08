import type { IDisposable } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'

export function createRangeHighlighter(api: FUniver) {
	let overlayDispose: IDisposable | null = null
	let overlayTimer: number | null = null

	const clear = () => {
		if (overlayTimer) window.clearTimeout(overlayTimer)
		overlayTimer = null
		overlayDispose?.dispose()
		overlayDispose = null
	}

	const highlight = (input: {
		sheetId?: string | null
		range: { startRow: number; startCol: number; endRow: number; endCol: number }
		style?: unknown
		durationMs?: number
	}) => {
		clear()

		const fWorkbook = api.getActiveWorkbook()
		if (!fWorkbook) return

		const fWorksheet = input.sheetId ? fWorkbook.getSheetBySheetId(input.sheetId) : fWorkbook.getActiveSheet()
		if (!fWorksheet) return

		if (input.sheetId) fWorkbook.setActiveSheet(input.sheetId)

		try {
			fWorksheet.scrollToCell(input.range.startRow, input.range.startCol, 120)
		} catch {}

		const fRange = fWorksheet.getRange({
			startRow: input.range.startRow,
			startColumn: input.range.startCol,
			endRow: input.range.endRow,
			endColumn: input.range.endCol,
		})
		const primaryRange = fWorksheet.getRange({
			startRow: input.range.startRow,
			startColumn: input.range.startCol,
			endRow: input.range.startRow,
			endColumn: input.range.startCol,
		}).getRange()

		overlayDispose = (fRange as any).highlight(input.style ?? null, {
			...primaryRange,
			actualRow: primaryRange.startRow,
			actualColumn: primaryRange.startColumn,
		})

		const ms =
			typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
				? Math.max(0, Math.floor(input.durationMs))
				: 0
		if (ms > 0) {
			overlayTimer = window.setTimeout(() => {
				overlayTimer = null
				clear()
			}, ms)
		}
	}

	return {
		clear,
		highlight,
	}
}
