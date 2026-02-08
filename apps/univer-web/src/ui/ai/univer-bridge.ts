import type { IDisposable } from '@univerjs/core'
import { HoverManagerService } from '@univerjs/sheets-ui'
import type { UniverAiContext } from 'pluxel-plugin-univer-ai'
import type { UniverRuntime } from '../univer/runtime'

export type UniverRangeRect = { startRow: number; startCol: number; endRow: number; endCol: number }

function toContext(input: {
	rt: UniverRuntime
	workbookId: string
	range: { startRow: number; startCol: number; endRow: number; endCol: number; startColumn?: number; endColumn?: number }
	a1: string
	limits?: { maxRows: number; maxCols: number }
}): UniverAiContext | null {
	const { rt, workbookId } = input
	const maxRows = input.limits?.maxRows ?? 40
	const maxCols = input.limits?.maxCols ?? 16

	const fWorkbook = rt.api.getActiveWorkbook()
	if (!fWorkbook) return null
	const fWorksheet = fWorkbook.getActiveSheet()
	if (!fWorksheet) return null

	const range = input.range as any
	const a1 = input.a1

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

	const fRange = fWorksheet.getRange({
		startRow: sliceRange.startRow,
		startColumn: sliceRange.startCol,
		endRow: sliceRange.endRow,
		endColumn: sliceRange.endCol,
	})

	const displayValues = fRange.getDisplayValues()
	return {
		workbookId,
		sheetId: fWorksheet.getSheetId(),
		range: sliceRange,
		a1,
		displayValues,
		meta: {
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
	rt: UniverRuntime
	workbookId: string
	limits?: { maxRows: number; maxCols: number }
}): { current: UniverAiContext; selections: UniverAiContext[] } | null {
	const fWorkbook = input.rt.api.getActiveWorkbook()
	if (!fWorkbook) return null
	const fWorksheet = fWorkbook.getActiveSheet()
	if (!fWorksheet) return null

	const selection = fWorksheet.getSelection?.()
	const active = selection?.getActiveRange?.() ?? fWorkbook.getActiveRange?.()
	if (!active) return null

	const activeList = selection?.getActiveRangeList?.() ?? []
	const ranges = activeList.length ? activeList : [active]

	const contexts: UniverAiContext[] = []
	for (const r of ranges) {
		const range = r.getRange?.()
		const a1 = r.getA1Notation?.(true)
		if (!range || typeof a1 !== 'string') continue
		const ctx = toContext({ rt: input.rt, workbookId: input.workbookId, range: range as any, a1, limits: input.limits })
		if (ctx) contexts.push(ctx)
	}
	if (!contexts.length) return null

	const activeA1 = active.getA1Notation?.(true)
	const current = contexts.find((c) => c.a1 === activeA1) ?? contexts[0]!
	const selections = contexts.filter((c) => c !== current)
	return { current, selections }
}

export function collectActiveSelectionContext(input: {
	rt: UniverRuntime
	workbookId: string
	limits?: { maxRows: number; maxCols: number }
}): UniverAiContext | null {
	const res = collectActiveSelectionContexts(input)
	return res?.current ?? null
}

export function subscribeHoverCell(
	rt: UniverRuntime,
	onCell: (cell: { sheetId: string; row: number; col: number } | null) => void,
): IDisposable {
	let hover: HoverManagerService
	try {
		const injector = (rt.univer as any).__getInjector?.()
		hover = injector?.get?.(HoverManagerService)
		if (!hover) {
			throw new Error('HoverManagerService not available')
		}
	} catch {
		return { dispose() {} } as IDisposable
	}

	const sub = hover.currentCell$.subscribe((pos: any) => {
		if (!pos?.location) {
			onCell(null)
			return
		}
		const sheetId = String((pos.location as any).subUnitId ?? '')
		const row = Number((pos.location as any).row)
		const col = Number((pos.location as any).col)
		if (!sheetId || !Number.isFinite(row) || !Number.isFinite(col)) {
			onCell(null)
			return
		}
		onCell({ sheetId, row, col })
	}) as { unsubscribe(): void }

	return {
		dispose() {
			sub.unsubscribe()
		},
	} as IDisposable
}
