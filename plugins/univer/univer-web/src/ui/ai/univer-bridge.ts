import type { UniverAiContext } from '@pluxel/univer-headless/protocol'
import type { FUniver } from '@univerjs/core/facade'

import { formatSheetNameForA1, rangeToA1 } from './a1'
import { coerceSheets, unwrapSheetEntry } from './sheets-utils'

export type UniverRangeRect = { startRow: number; startCol: number; endRow: number; endCol: number }

function getSheetName(sheet: any): string {
	const name = typeof sheet?.getName === 'function' ? String(sheet.getName()) : ''
	return name.trim() || 'Sheet'
}

export function getActiveSheetWholeA1(input: { api: FUniver }): { sheetId: string; sheetName: string; a1: string; range: UniverRangeRect } | null {
	const fWorkbook = input.api.getActiveWorkbook()
	if (!fWorkbook) return null
	const fWorksheet = fWorkbook.getActiveSheet()
	if (!fWorksheet) return null

	const sheetName = typeof fWorksheet.getSheetName === 'function' ? String(fWorksheet.getSheetName()) : getSheetName(fWorksheet)
	const sheetId = typeof fWorksheet.getSheetId === 'function' ? String(fWorksheet.getSheetId()) : ''
	const sheet = typeof fWorksheet.getSheet === 'function' ? fWorksheet.getSheet() : null
	const rows = typeof sheet?.getRowCount === 'function' ? Number(sheet.getRowCount()) : NaN
	const cols = typeof sheet?.getColumnCount === 'function' ? Number(sheet.getColumnCount()) : NaN
	if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows <= 0 || cols <= 0) return null

	const range: UniverRangeRect = { startRow: 0, startCol: 0, endRow: Math.floor(rows) - 1, endCol: Math.floor(cols) - 1 }
	const base = rangeToA1(range)
	const a1 = sheetName ? `${formatSheetNameForA1(sheetName)}!${base}` : base
	return { sheetId, sheetName, a1, range }
}

export function getSheetWholeA1(input: {
	api: FUniver
	sheetId?: string | null
}): { sheetId: string; sheetName: string; a1: string; range: UniverRangeRect } | null {
	const fWorkbook = input.api.getActiveWorkbook()
	if (!fWorkbook) return null

	const id = String(input.sheetId ?? '').trim()
	const fWorksheet = id ? fWorkbook.getSheetBySheetId(id) : fWorkbook.getActiveSheet()
	if (!fWorksheet) return null

	const sheetName = typeof fWorksheet.getSheetName === 'function' ? String(fWorksheet.getSheetName()) : getSheetName(fWorksheet)
	const sheetId = typeof fWorksheet.getSheetId === 'function' ? String(fWorksheet.getSheetId()) : id
	const sheet = typeof fWorksheet.getSheet === 'function' ? fWorksheet.getSheet() : null
	const rows = typeof sheet?.getRowCount === 'function' ? Number(sheet.getRowCount()) : NaN
	const cols = typeof sheet?.getColumnCount === 'function' ? Number(sheet.getColumnCount()) : NaN
	if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows <= 0 || cols <= 0) return null

	const range: UniverRangeRect = { startRow: 0, startCol: 0, endRow: Math.floor(rows) - 1, endCol: Math.floor(cols) - 1 }
	const base = rangeToA1(range)
	const a1 = sheetName ? `${formatSheetNameForA1(sheetName)}!${base}` : base
	return { sheetId, sheetName, a1, range }
}

export function getWorkbookWholeA1List(input: {
	api: FUniver
	maxSheets?: number
}): Array<{ sheetId: string; sheetName: string; a1: string; range: UniverRangeRect }> {
	const maxSheets = typeof input.maxSheets === 'number' && Number.isFinite(input.maxSheets) ? Math.max(1, Math.floor(input.maxSheets)) : 64
	const fWorkbook: any = input.api.getActiveWorkbook?.()
	if (!fWorkbook) return []

	const active: any = fWorkbook.getActiveSheet?.()
	const activeId = typeof active?.getSheetId === 'function' ? String(active.getSheetId()) : ''

	const rawSheets: any[] = coerceSheets(typeof fWorkbook.getSheets === 'function' ? fWorkbook.getSheets() : null)
	const ids: string[] = []
	for (const s of rawSheets) {
		const sheet = unwrapSheetEntry(s)
		const id =
			typeof sheet?.getSheetId === 'function'
				? String(sheet.getSheetId())
				: typeof sheet?.getId === 'function'
					? String(sheet.getId())
					: typeof sheet?.sheetId === 'string'
						? sheet.sheetId
						: typeof sheet?.id === 'string'
							? sheet.id
							: ''
		if (!id) continue
		ids.push(id)
	}

	const ordered = activeId ? [activeId, ...ids.filter((x) => x !== activeId)] : ids
	const out: Array<{ sheetId: string; sheetName: string; a1: string; range: UniverRangeRect }> = []
	for (const id of ordered.slice(0, maxSheets)) {
		const item = getSheetWholeA1({ api: input.api, sheetId: id })
		if (item) out.push(item)
	}

	// Fallback: at least return the active sheet scope.
	if (!out.length) {
		const one = getSheetWholeA1({ api: input.api })
		if (one) out.push(one)
	}
	return out
}

function makeA1(sheetName: string, range: UniverRangeRect): string {
	const base = rangeToA1(range)
	return sheetName ? `${formatSheetNameForA1(sheetName)}!${base}` : base
}

function toContext(input: {
	api: FUniver
	workbookId: string
	range: { startRow: number; startCol: number; endRow: number; endCol: number; startColumn?: number; endColumn?: number }
	limits?: { maxRows: number; maxCols: number }
}): UniverAiContext | null {
	const { api, workbookId } = input
	const maxRows = input.limits?.maxRows ?? 40
	const maxCols = input.limits?.maxCols ?? 16

	const fWorkbook = api.getActiveWorkbook()
	if (!fWorkbook) return null
	const fWorksheet = fWorkbook.getActiveSheet()
	if (!fWorksheet) return null

	const range = input.range as any
	const sheetName = getSheetName(fWorksheet)

	const origRows = range.endRow - range.startRow + 1
	const startCol = typeof range.startCol === 'number' ? range.startCol : range.startColumn
	const endColRaw = typeof range.endCol === 'number' ? range.endCol : range.endColumn
	const origCols = endColRaw - startCol + 1

	const endRow = Math.min(range.endRow, range.startRow + maxRows - 1)
	const endCol = Math.min(endColRaw, startCol + maxCols - 1)
	const sliceRange: UniverRangeRect = {
		startRow: range.startRow,
		startCol,
		endRow,
		endCol,
	}
	const a1 = makeA1(sheetName, sliceRange)

	const fRange = fWorksheet.getRange({
		startRow: sliceRange.startRow,
		startColumn: sliceRange.startCol,
		endRow: sliceRange.endRow,
		endColumn: sliceRange.endCol,
	})

	const displayValues = fRange.getDisplayValues()
	return {
		workbookId,
		selection: {
			sheetId: fWorksheet.getSheetId(),
			a1,
			range: sliceRange,
			display: displayValues,
			truncated: origRows > maxRows || origCols > maxCols,
			orig: {
				startRow: range.startRow,
				startCol,
				endRow: range.endRow,
				endCol: endColRaw,
				rows: origRows,
				cols: origCols,
			},
			limits: { maxRows, maxCols },
		},
	}
}

export function collectActiveSelectionContexts(input: {
	api: FUniver
	workbookId: string
	limits?: { maxRows: number; maxCols: number }
}): { current: UniverAiContext; selections: UniverAiContext[] } | null {
	const fWorkbook = input.api.getActiveWorkbook()
	if (!fWorkbook) return null
	const fWorksheet = fWorkbook.getActiveSheet()
	if (!fWorksheet) return null

	const selection = fWorksheet.getSelection?.()
	const active = selection?.getActiveRange?.() ?? fWorkbook.getActiveRange?.()
	if (!active) return null

	const activeList = selection?.getActiveRangeList?.() ?? []
	const ranges = activeList.length ? activeList : [active]

	const activeKey = (() => {
		const r = active.getRange?.() as any
		if (!r) return null
		const startCol = typeof r.startCol === 'number' ? r.startCol : r.startColumn
		const endCol = typeof r.endCol === 'number' ? r.endCol : r.endColumn
		if (typeof startCol !== 'number' || typeof endCol !== 'number') return null
		return `${r.startRow}:${startCol}-${r.endRow}:${endCol}`
	})()

	const contexts: UniverAiContext[] = []
	let currentIndex = -1
	for (const r of ranges) {
		const range = r.getRange?.()
		if (!range) continue
		const ctx = toContext({ api: input.api, workbookId: input.workbookId, range: range as any, limits: input.limits })
		if (ctx) contexts.push(ctx)

		if (ctx && activeKey) {
			const rr = ctx.selection.range
			const key = rr ? `${rr.startRow}:${rr.startCol}-${rr.endRow}:${rr.endCol}` : null
			if (key && key === activeKey) currentIndex = contexts.length - 1
		}
	}
	if (!contexts.length) return null

	const current = currentIndex >= 0 ? contexts[currentIndex]! : contexts[0]!
	const selections = contexts.filter((c) => c !== current)
	return { current, selections }
}

export function collectActiveSelectionContext(input: {
	api: FUniver
	workbookId: string
	limits?: { maxRows: number; maxCols: number }
}): UniverAiContext | null {
	const res = collectActiveSelectionContexts(input)
	return res?.current ?? null
}
