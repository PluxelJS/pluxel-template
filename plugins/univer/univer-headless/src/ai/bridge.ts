import type {
	UniverAiApplyOpsV1Input,
	UniverAiApplyOpsV1Result,
	UniverAiClearRangeInput,
	UniverAiClearRangeResult,
	UniverAiListSheetsResult,
	UniverAiOpsV1,
	UniverAiReadRangeDisplayInput,
	UniverAiReadRangeDisplayResult,
	UniverAiToolCall,
	UniverAiToolResult,
	UniverAiToolSpec,
	UniverRange,
} from '../protocol'
import { parseA1Range } from './a1'

function clampInt(n: unknown, min: number, max: number) {
	const v = typeof n === 'number' && Number.isFinite(n) ? n : min
	return Math.max(min, Math.min(max, Math.floor(v)))
}

function normalizeMatrixToString(input: unknown): string[][] {
	if (!Array.isArray(input)) return []
	return input.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []))
}

function clipRange(range: UniverRange, limits?: { maxRows?: number; maxCols?: number }) {
	const maxRows = clampInt(limits?.maxRows, 1, 2000)
	const maxCols = clampInt(limits?.maxCols, 1, 2000)
	const rows = range.endRow - range.startRow + 1
	const cols = range.endCol - range.startCol + 1
	const clippedRows = Math.min(rows, maxRows)
	const clippedCols = Math.min(cols, maxCols)
	const truncated = clippedRows !== rows || clippedCols !== cols
	const clipped: UniverRange = {
		startRow: range.startRow,
		startCol: range.startCol,
		endRow: range.startRow + clippedRows - 1,
		endCol: range.startCol + clippedCols - 1,
	}
	return { clipped, truncated, maxRows, maxCols }
}

function resolveSheet(workbook: any, sheetId?: string, sheetName?: string) {
	if (!workbook) throw new Error('[univer] workbook missing')
	if (sheetId) {
		const byId = workbook.getSheetBySheetId?.(sheetId)
		if (byId) return byId
	}
	if (sheetName) {
		const byName = workbook.getSheetByName?.(sheetName)
		if (byName) return byName
	}
	const active = workbook.getActiveSheet?.()
	if (active) return active
	const sheets = workbook.getSheets?.() ?? []
	if (Array.isArray(sheets) && sheets.length) return sheets[0]
	throw new Error('[univer] no sheets available')
}

function getSheetId(sheet: any): string {
	const id = typeof sheet?.getSheetId === 'function' ? String(sheet.getSheetId()) : ''
	if (!id) throw new Error('[univer] invalid sheetId')
	return id
}

function getSheetName(sheet: any): string {
	const name = typeof sheet?.getName === 'function' ? String(sheet.getName()) : ''
	return name || 'Sheet'
}

type RowWriteOp =
	| { kind: 'clear'; row: number; startCol: number; endCol: number }
	| { kind: 'set'; row: number; startCol: number; endCol: number; values: string[] }

function buildRowWriteOps(
	ops: ReadonlyArray<{ row: number; col: number; kind: 'clear' | 'set'; value?: string }>,
) {
	const byRow = new Map<number, { col: number; kind: 'clear' | 'set'; value?: string }[]>()
	for (const op of ops) {
		const list = byRow.get(op.row) ?? []
		list.push({ col: op.col, kind: op.kind, value: op.value })
		byRow.set(op.row, list)
	}

	const out: RowWriteOp[] = []
	const rows = Array.from(byRow.keys()).sort((a, b) => a - b)
	for (const row of rows) {
		const items = (byRow.get(row) ?? []).slice().sort((a, b) => a.col - b.col)
		if (!items.length) continue

		let startCol = items[0]!.col
		let prevCol = items[0]!.col
		let kind: RowWriteOp['kind'] = items[0]!.kind === 'clear' ? 'clear' : 'set'
		let values: string[] = kind === 'set' ? [String(items[0]!.value ?? '')] : []

		for (let i = 1; i < items.length; i++) {
			const it = items[i]!
			const contiguous = it.col === prevCol + 1
			const nextKind: RowWriteOp['kind'] = it.kind === 'clear' ? 'clear' : 'set'
			if (contiguous && nextKind === kind) {
				if (kind === 'set') values.push(String(it.value ?? ''))
				prevCol = it.col
				continue
			}

			out.push(
				kind === 'clear'
					? { kind: 'clear', row, startCol, endCol: prevCol }
					: { kind: 'set', row, startCol, endCol: prevCol, values },
			)

			startCol = it.col
			prevCol = it.col
			kind = nextKind
			values = kind === 'set' ? [String(it.value ?? '')] : []
		}

		out.push(
			kind === 'clear'
				? { kind: 'clear', row, startCol, endCol: prevCol }
				: { kind: 'set', row, startCol, endCol: prevCol, values },
		)
	}

	return out
}

export const UNIVER_AI_TOOL_SPECS: ReadonlyArray<UniverAiToolSpec> = [
	{ name: 'univer.listSheets', description: 'List workbook sheets (sheetId + name).' },
	{
		name: 'univer.readRangeDisplay',
		description: 'Read display values for an A1 range (clipped by limits).',
	},
	{
		name: 'univer.applyOpsV1',
		description: 'Apply cell ops (set/clear) by absolute 0-based (row,col).',
	},
	{ name: 'univer.clearRange', description: 'Clear cell contents for a range (0-based indices).' },
]

export type UniverAiBridge = Readonly<{
	workbook: any
	tools: ReadonlyArray<UniverAiToolSpec>
	listSheets(): UniverAiListSheetsResult
	readRangeDisplay(input: UniverAiReadRangeDisplayInput): UniverAiReadRangeDisplayResult
	applyOpsV1(input: UniverAiApplyOpsV1Input): UniverAiApplyOpsV1Result
	clearRange(input: UniverAiClearRangeInput): UniverAiClearRangeResult
	call(call: UniverAiToolCall): Promise<UniverAiToolResult<unknown>>
}>

export function createUniverAiBridge(workbook: any): UniverAiBridge {
	const listSheets = (): UniverAiListSheetsResult => {
		const sheets = (workbook?.getSheets?.() ?? []) as unknown[]
		const out: Array<{ sheetId: string; name: string }> = []
		for (const s of sheets) {
			try {
				const sheetId = getSheetId(s)
				const name = getSheetName(s)
				out.push({ sheetId, name })
			} catch {
				// ignore invalid sheets
			}
		}
		return { sheets: out }
	}

	const readRangeDisplay = (
		input: UniverAiReadRangeDisplayInput,
	): UniverAiReadRangeDisplayResult => {
		const a1 = String(input?.a1 ?? '').trim()
		if (!a1) throw new Error('[univer] a1 required')
		const parsed = parseA1Range(a1)
		const sheet = resolveSheet(workbook, input.sheetId, parsed.sheetName)
		const sheetId = getSheetId(sheet)

		const { clipped, truncated, maxRows, maxCols } = clipRange(parsed.range, input.limits)
		const values = sheet
			.getRange({
				startRow: clipped.startRow,
				startColumn: clipped.startCol,
				endRow: clipped.endRow,
				endColumn: clipped.endCol,
			})
			.getDisplayValues()

		const matrix = normalizeMatrixToString(values)
		const clippedMatrix: string[][] = []
		for (let r = 0; r < Math.min(maxRows, matrix.length); r++) {
			clippedMatrix.push((matrix[r] ?? []).slice(0, maxCols))
		}

		return {
			sheetId,
			a1: parsed.a1,
			range: clipped,
			values: clippedMatrix,
			truncated: truncated || undefined,
		}
	}

	const applyOpsV1 = (input: UniverAiApplyOpsV1Input): UniverAiApplyOpsV1Result => {
		const sheetId = String(input?.sheetId ?? '').trim()
		if (!sheetId) throw new Error('[univer] sheetId required')
		const sheet = resolveSheet(workbook, sheetId, undefined)
		const ops = Array.isArray(input?.ops) ? (input.ops as UniverAiOpsV1[]) : []
		if (!ops.length) return { appliedOps: 0 }

		const cellOps = ops.map((op) => {
			const row = op.row
			const col = op.col
			if (!Number.isInteger(row) || row < 0) throw new Error('[univer] op.row must be a non-negative integer')
			if (!Number.isInteger(col) || col < 0) throw new Error('[univer] op.col must be a non-negative integer')
			if (op.op === 'clear') return { row, col, kind: 'clear' as const }
			if (op.op === 'set') return { row, col, kind: 'set' as const, value: String(op.value ?? '') }
			// Exhaustive: UniverAiOpsV1 is a closed union.
			const _exhaustive: never = op
			throw new Error(`[univer] unknown ops-v1 op: ${String((op as { op?: unknown }).op ?? '')}`)
		})

		let appliedOps = 0
		const rowOps = buildRowWriteOps(cellOps)
		for (const rop of rowOps) {
			const range = sheet.getRange({
				startRow: rop.row,
				startColumn: rop.startCol,
				endRow: rop.row,
				endColumn: rop.endCol,
			})
			if (rop.kind === 'clear') {
				range.clearContent()
			} else {
				range.setValues([rop.values])
			}
			appliedOps += rop.endCol - rop.startCol + 1
		}

		return { appliedOps }
	}

	const clearRange = (input: UniverAiClearRangeInput): UniverAiClearRangeResult => {
		const sheetId = String(input?.sheetId ?? '').trim()
		if (!sheetId) throw new Error('[univer] sheetId required')
		const r = input?.range as UniverRange
		if (!r) throw new Error('[univer] range required')
		const sheet = resolveSheet(workbook, sheetId, undefined)
		sheet
			.getRange({
				startRow: r.startRow,
				startColumn: r.startCol,
				endRow: r.endRow,
				endColumn: r.endCol,
			})
			.clearContent()
		return { cleared: true }
	}

	const call: UniverAiBridge['call'] = async (c) => {
		try {
			if (c.tool === 'univer.listSheets') return { ok: true, value: listSheets() }
			if (c.tool === 'univer.readRangeDisplay') return { ok: true, value: readRangeDisplay(c.args) }
			if (c.tool === 'univer.applyOpsV1') return { ok: true, value: applyOpsV1(c.args) }
			if (c.tool === 'univer.clearRange') return { ok: true, value: clearRange(c.args) }
			return { ok: false, error: `[univer] unknown tool: ${String((c as { tool?: unknown }).tool ?? '')}` }
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) }
		}
	}

	return {
		workbook,
		tools: UNIVER_AI_TOOL_SPECS,
		listSheets,
		readRangeDisplay,
		applyOpsV1,
		clearRange,
		call,
	}
}
