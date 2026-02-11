import type { IDisposable } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'

export function createRangeHighlighter(api: FUniver) {
	let focusDispose: IDisposable | null = null
	let focusTimer: number | null = null
	let sessionDisposables: IDisposable[] = []

	const clearFocus = () => {
		if (focusTimer) window.clearTimeout(focusTimer)
		focusTimer = null
		focusDispose?.dispose()
		focusDispose = null
	}

	const clearSession = () => {
		for (const d of sessionDisposables) d.dispose()
		sessionDisposables = []
	}

	const clear = () => {
		clearFocus()
		clearSession()
	}

	const highlight = (input: {
		sheetId?: string | null
		range: { startRow: number; startCol: number; endRow: number; endCol: number }
		style?: unknown
		durationMs?: number
	}) => {
		clearFocus()

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

		focusDispose = (fRange as any).highlight(input.style ?? null, {
			...primaryRange,
			actualRow: primaryRange.startRow,
			actualColumn: primaryRange.startColumn,
		})

		const ms =
			typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
				? Math.max(0, Math.floor(input.durationMs))
				: 0
		if (ms > 0) {
			focusTimer = window.setTimeout(() => {
				focusTimer = null
				clearFocus()
			}, ms)
		}
	}

	const setHighlights = (input: {
		items: ReadonlyArray<{
			sheetId?: string | null
			range: { startRow: number; startCol: number; endRow: number; endCol: number }
			style?: unknown
		}>
	}) => {
		clearSession()

		const fWorkbook = api.getActiveWorkbook()
		if (!fWorkbook) return

			const active = fWorkbook.getActiveSheet()
			const activeId: string | null = (() => {
				const id = active?.getSheetId?.()
				return id ? String(id) : null
			})()
			if (!activeId) return

		for (const item of input.items) {
			if (!item) continue
				const targetSheetId: string = item.sheetId ? String(item.sheetId) : activeId
			// Univer sheet highlights are bound to the active sheet renderer/selection service.
			// Highlighting non-active sheets will "jump" when the user switches tabs.
			// So we only render highlights for the current active sheet.
			if (targetSheetId !== activeId) continue

			const fRange = active.getRange({
				startRow: item.range.startRow,
				startColumn: item.range.startCol,
				endRow: item.range.endRow,
				endColumn: item.range.endCol,
			})

			// Passing `null` clears the "primary cell" so the whole range uses the same fill.
			const disp = (fRange as any).highlight(item.style ?? null, null)
			sessionDisposables.push(disp)
		}
	}

	return {
		clear,
		highlight,
		setHighlights,
	}
}
