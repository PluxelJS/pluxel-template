import type { AxFunction } from '@ax-llm/ax'
import { Type } from '@sinclair/typebox'
import type {
	UniverRange,
	UniverToolGetRangesDataInput,
	UniverToolGetRangesDataResult,
	UniverToolAutoFillInput,
	UniverToolAutoFillResult,
	UniverToolFillFormulaInput,
	UniverToolFillFormulaResult,
	UniverToolGetRangeDataInput,
	UniverToolGetRangeDataResult,
	UniverToolSearchCellsInput,
	UniverToolSearchCellsResult,
	UniverToolSetRangesDataInput,
	UniverToolSetRangesDataResult,
	UniverToolSetRangeDataInput,
	UniverToolSetRangeDataResult,
} from '../../protocol'

import { getMcpToolDescription } from './catalog'
import type { McpContext } from './context'
import { formatA1Range } from '../a1'
import { resolveRangeInput, resolveSheet, getSheetId, getSheetName, toMatrix, toStringMatrix, normalizeCount } from './utils'
import { normalizeWriteMatrixForRange } from './write-normalize'
import { asAxParams } from '../ax-params'
const A1RangeSchema = Type.Object(
	{
		/**
		 * Sheet-qualified A1 notation, e.g. `Sheet1!A1:D40` or `'My Sheet'!A1:B2`.
		 * (Always include the sheet name to avoid ambiguity.)
		 */
		a1: Type.String(),
	},
	{ additionalProperties: false },
)

const CellValueSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])

const SetRangeDataSchema = Type.Object(
	{
		...A1RangeSchema.properties,
		values: Type.Array(Type.Array(CellValueSchema)),
		readback: Type.Optional(
			Type.Object(
				{
					includeDisplay: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
)

const GetRangeDataSchema = Type.Object(
	{
		...A1RangeSchema.properties,
		includeDisplay: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
)

const GetRangesDataSchema = Type.Object(
	{
		ranges: Type.Array(GetRangeDataSchema),
		includeDisplay: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
)

const SetRangesDataSchema = Type.Object(
	{
		updates: Type.Array(SetRangeDataSchema),
		readback: Type.Optional(
			Type.Object(
				{
					includeDisplay: Type.Optional(Type.Boolean()),
					ranges: Type.Optional(Type.Array(GetRangeDataSchema)),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
)

const SearchCellsSchema = Type.Object(
	{
		...A1RangeSchema.properties,
		query: Type.String(),
		match: Type.Optional(Type.Union([Type.Literal('contains'), Type.Literal('exact'), Type.Literal('regex')])),
		caseSensitive: Type.Optional(Type.Boolean()),
		maxResults: Type.Optional(Type.Integer()),
	},
	{ additionalProperties: false },
)

const AutoFillSchema = Type.Object(
	{
		source: A1RangeSchema,
		target: A1RangeSchema,
		readback: Type.Optional(
			Type.Object(
				{
					includeDisplay: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
)

const FillFormulaSchema = Type.Object(
	{
		...A1RangeSchema.properties,
		formula: Type.String(),
		readback: Type.Optional(
			Type.Object(
				{
					includeDisplay: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
)

function tileMatrix(source: unknown[][], targetRows: number, targetCols: number): unknown[][] {
	const srcRows = source.length
	const srcCols = Math.max(0, ...source.map((r) => r.length))
	if (srcRows === 0 || srcCols === 0) return Array.from({ length: targetRows }, () => Array(targetCols).fill(''))
	const out: unknown[][] = []
	for (let r = 0; r < targetRows; r++) {
		const row: unknown[] = []
		for (let c = 0; c < targetCols; c++) {
			const v = source[r % srcRows]?.[c % srcCols]
			row.push(v ?? '')
		}
		out.push(row)
	}
	return out
}

function computeRangeSize(range: UniverRange) {
	return {
		rows: Math.max(0, range.endRow - range.startRow + 1),
		cols: Math.max(0, range.endCol - range.startCol + 1),
	}
}

function clipRange(range: UniverRange, limits?: { maxRows: number; maxCols: number }) {
	const maxRows = limits?.maxRows ?? 40
	const maxCols = limits?.maxCols ?? 16
	const rows = Math.max(0, range.endRow - range.startRow + 1)
	const cols = Math.max(0, range.endCol - range.startCol + 1)
	const clippedRows = Math.min(rows, Math.max(1, Math.floor(maxRows)))
	const clippedCols = Math.min(cols, Math.max(1, Math.floor(maxCols)))
	const truncated = clippedRows !== rows || clippedCols !== cols
	const clipped: UniverRange = {
		startRow: range.startRow,
		startCol: range.startCol,
		endRow: range.startRow + clippedRows - 1,
		endCol: range.startCol + clippedCols - 1,
	}
	return { clipped, truncated }
}

function indexToColLetters(col0: number) {
	let n = Math.floor(col0) + 1
	let out = ''
	while (n > 0) {
		const rem = (n - 1) % 26
		out = String.fromCharCode(65 + rem) + out
		n = Math.floor((n - 1) / 26)
	}
	return out
}

function shiftFormulaA1(formula: string, deltaRow: number, deltaCol: number) {
	// Best-effort A1 reference shifting:
	// - Skips string literals "..."
	// - Shifts references like A1, $A1, A$1, $A$1, and also range endpoints A1:B2
	// - Leaves sheet-qualified refs (Sheet!A1 or 'Sheet 1'!A1) unchanged
	if (!formula.startsWith('=')) throw new Error('[univer] fill_formula formula must start with "="')
	if (!deltaRow && !deltaCol) return formula

	let out = ''
	let i = 0
	let inString = false

	while (i < formula.length) {
		const ch = formula[i]!
		if (ch === '"') {
			inString = !inString
			out += ch
			i++
			continue
		}
		if (inString) {
			out += ch
			i++
			continue
		}

		// If this looks like a sheet-qualified cell ref, skip shifting (e.g. Sheet1!A1, 'Sheet 1'!A1)
		// We'll detect the "!" later by looking back from a match start: if preceded by "!" within a small window.
		const m = formula.slice(i).match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/)
		if (!m) {
			out += ch
			i++
			continue
		}

		const full = m[0]!
		const absCol = m[1] === '$'
		const letters = m[2]!
		const absRow = m[3] === '$'
		const row1 = Number(m[4]!)
		if (!Number.isFinite(row1) || row1 <= 0) {
			out += full
			i += full.length
			continue
		}

		// Heuristic: if immediately preceded by "!" (sheet qualifier), don't shift.
		const prev = out.at(-1)
		if (prev === '!') {
			out += full
			i += full.length
			continue
		}

		// Column
		let col0 = 0
		for (const c of letters.toUpperCase()) {
			if (c < 'A' || c > 'Z') throw new Error(`[univer] invalid column letters: ${letters}`)
			col0 = col0 * 26 + (c.charCodeAt(0) - 64)
		}
		col0 -= 1
		const nextCol0 = absCol ? col0 : col0 + deltaCol
		const nextRow1 = absRow ? row1 : row1 + deltaRow
		if (nextCol0 < 0 || nextRow1 <= 0) {
			throw new Error('[univer] fill_formula produced an invalid cell reference after shifting; adjust the base formula or use absolute refs ($)')
		}
		out += `${absCol ? '$' : ''}${indexToColLetters(nextCol0)}${absRow ? '$' : ''}${nextRow1}`
		i += full.length
	}

	return out
}

export function createDataTools(ctx: McpContext): AxFunction[] {
	const getRangeDataOnce = async (input: UniverToolGetRangeDataInput): Promise<UniverToolGetRangeDataResult> => {
		const { range: origRange, sheetName, a1 } = resolveRangeInput(input)
		const effSheetName = sheetName ?? input.sheetName ?? ctx.defaultSheetName
		const effSheetId =
			input.sheetId ??
			(effSheetName ? ctx.sheetNameToId.get(effSheetName) : undefined) ??
			ctx.defaultSheetId
		ctx.checkReadRange(origRange, effSheetId, effSheetName)

		const { clipped: range, truncated } = clipRange(origRange, ctx.viewLimits)
		const sheet = resolveSheet(ctx.workbook, effSheetId, effSheetName)
		const sheetId = getSheetId(sheet)
		const resolvedSheetName = getSheetName(sheet)
		const epoch = ctx.cache?.epoch ?? 0
		const cacheKey = `${epoch}|get_range_data|${sheetId}|${range.startRow},${range.startCol},${range.endRow},${range.endCol}|${input.includeDisplay ? 1 : 0}`
		const hit = ctx.cache?.get(cacheKey)
		if (hit !== undefined) return hit as UniverToolGetRangeDataResult

		const r = sheet.getRange({
			startRow: range.startRow,
			startColumn: range.startCol,
			endRow: range.endRow,
			endColumn: range.endCol,
		})
		const values = typeof r.getValues === 'function' ? r.getValues() : r.getDisplayValues()
		const displayValues = input.includeDisplay ? toStringMatrix(r.getDisplayValues()) : undefined
		const returnedA1 = formatA1Range(resolvedSheetName, range)
		const requestedA1 = a1 ?? formatA1Range(resolvedSheetName, origRange)
		const res: UniverToolGetRangeDataResult = {
			sheetId,
			sheetName: resolvedSheetName,
			a1: returnedA1,
			...(truncated && requestedA1 !== returnedA1 ? { requestedA1 } : {}),
			range,
			values: toMatrix(values),
			...(displayValues ? { displayValues } : {}),
			...(truncated ? { truncated: true, origRange } : {}),
		}
		ctx.cache?.set(cacheKey, res)
		return res
	}

	const set_range_data: AxFunction = {
		name: 'set_range_data',
		description: getMcpToolDescription('set_range_data'),
		parameters: asAxParams(SetRangeDataSchema),
		func: async (input: UniverToolSetRangeDataInput): Promise<UniverToolSetRangeDataResult> => {
			ctx.stats.toolCalls++

			const { range: requestedRange, sheetName } = resolveRangeInput(input)
			const effSheetName = sheetName ?? input.sheetName ?? ctx.defaultSheetName
			const effSheetId =
				input.sheetId ??
				(effSheetName ? ctx.sheetNameToId.get(effSheetName) : undefined) ??
				ctx.defaultSheetId
			ctx.checkWriteRange(requestedRange, effSheetId, effSheetName)

			const sheet = resolveSheet(ctx.workbook, effSheetId, effSheetName)
			const sheetNameForA1 = getSheetName(sheet)
			const normalized = normalizeWriteMatrixForRange(input.values, requestedRange, sheetNameForA1)
			const range = normalized.range
			const values = normalized.values
			const updatedCells = normalized.updatedCells
			if (!updatedCells) return { updatedCells: 0, ...(normalized.warning ? { warning: normalized.warning } : {}) }

			ctx.checkCanChange()
			ctx.checkCanApplyOps(updatedCells)
			const r = sheet.getRange({
				startRow: range.startRow,
				startColumn: range.startCol,
				endRow: range.endRow,
				endColumn: range.endCol,
			})
			r.setValues(values)
			ctx.bumpChange()
			ctx.stats.appliedOps += updatedCells
			const wantReadback = !!input.readback
			if (!wantReadback) return { updatedCells, ...(normalized.warning ? { warning: normalized.warning } : {}) }

			const includeDisplay = Boolean(input.readback?.includeDisplay)
			ctx.stats.readCalls++
			const item = await getRangeDataOnce({
				...(effSheetId ? { sheetId: effSheetId } : {}),
				...(effSheetName ? { sheetName: effSheetName } : {}),
				range,
				...(includeDisplay ? { includeDisplay: true } : {}),
			})
			const key = String(item.requestedA1 ?? item.a1)
			return { updatedCells, ...(normalized.warning ? { warning: normalized.warning } : {}), readback: { order: [key], byA1: { [key]: item } } }
		},
	}

	const set_ranges_data: AxFunction = {
		name: 'set_ranges_data',
		description: getMcpToolDescription('set_ranges_data'),
		parameters: asAxParams(SetRangesDataSchema),
		func: async (input: UniverToolSetRangesDataInput): Promise<UniverToolSetRangesDataResult> => {
			ctx.stats.toolCalls++
			const updates = Array.isArray(input.updates) ? input.updates : []
			if (!updates.length) return { updates: 0, updatedCells: 0 }

			type ResolvedUpdate = {
				range: UniverRange
				sheet: any
				sheetId: string
				sheetName: string
				values: unknown[][]
				updatedCells: number
				warning?: string
			}
			const resolved: ResolvedUpdate[] = []
			let totalCells = 0
			const warnings: string[] = []

			for (const u of updates) {
				const { range: requestedRange, sheetName } = resolveRangeInput(u)
				const effSheetName = sheetName ?? u.sheetName ?? ctx.defaultSheetName
				const effSheetId = u.sheetId ?? (effSheetName ? ctx.sheetNameToId.get(effSheetName) : undefined) ?? ctx.defaultSheetId
				ctx.checkWriteRange(requestedRange, effSheetId, effSheetName)
				const sheet = resolveSheet(ctx.workbook, effSheetId, effSheetName)
				const resolvedSheetId = getSheetId(sheet)
				const resolvedSheetName = getSheetName(sheet)
				const normalized = normalizeWriteMatrixForRange(u.values, requestedRange, resolvedSheetName)
				const range = normalized.range
				const values = normalized.values
				const updatedCells = normalized.updatedCells
				if (!updatedCells) continue
				totalCells += updatedCells
				if (normalized.warning) warnings.push(normalized.warning)
				resolved.push({ range, sheet, sheetId: resolvedSheetId, sheetName: resolvedSheetName, values, updatedCells, ...(normalized.warning ? { warning: normalized.warning } : {}) })
			}

			if (!resolved.length) return { updates: 0, updatedCells: 0, ...(warnings.length ? { warnings } : {}) }

			ctx.checkCanChange()
			ctx.checkCanApplyOps(totalCells)

			for (const u of resolved) {
				const r = u.sheet.getRange({
					startRow: u.range.startRow,
					startColumn: u.range.startCol,
					endRow: u.range.endRow,
					endColumn: u.range.endCol,
				})
				r.setValues(u.values)
			}

			ctx.bumpChange()
			ctx.stats.appliedOps += totalCells
			const wantReadback = !!input.readback
			if (!wantReadback) return { updates: resolved.length, updatedCells: totalCells, ...(warnings.length ? { warnings } : {}) }

			const includeDisplay = Boolean(input.readback?.includeDisplay)
			const requested = Array.isArray(input.readback?.ranges) && input.readback?.ranges.length ? input.readback.ranges : []

			const defaultReadbackRanges: UniverToolGetRangeDataInput[] = resolved.map((u) => ({
				sheetId: u.sheetId,
				sheetName: u.sheetName,
				range: u.range,
			}))

			const ranges = (requested.length ? requested : defaultReadbackRanges).map((r) => ({
				...r,
				...(includeDisplay ? { includeDisplay: true } : {}),
			}))

			const order: string[] = []
			const byA1: Record<string, UniverToolGetRangeDataResult> = {}
			const seen = new Set<string>()
			for (const r of ranges) {
				ctx.stats.readCalls++
				const item = await getRangeDataOnce(r)
				const key = String(item.requestedA1 ?? item.a1)
				byA1[key] = item
				if (!seen.has(key)) {
					seen.add(key)
					order.push(key)
				}
			}

			return { updates: resolved.length, updatedCells: totalCells, readback: { order, byA1 } }
		},
	}

	const get_range_data: AxFunction = {
		name: 'get_range_data',
		description: getMcpToolDescription('get_range_data'),
		parameters: asAxParams(GetRangeDataSchema),
		func: async (input: UniverToolGetRangeDataInput): Promise<UniverToolGetRangeDataResult> => {
			ctx.stats.toolCalls++
			ctx.stats.readCalls++
			return getRangeDataOnce(input)
		},
	}

	const get_ranges_data: AxFunction = {
		name: 'get_ranges_data',
		description: getMcpToolDescription('get_ranges_data'),
		parameters: asAxParams(GetRangesDataSchema),
		func: async (input: UniverToolGetRangesDataInput): Promise<UniverToolGetRangesDataResult> => {
			ctx.stats.toolCalls++
			ctx.stats.readCalls++

			const ranges = Array.isArray(input.ranges) ? input.ranges : []
			if (!ranges.length) return { order: [], byA1: {} }
			const includeDisplay = typeof input.includeDisplay === 'boolean' ? input.includeDisplay : undefined

			const order: string[] = []
			const byA1: Record<string, UniverToolGetRangeDataResult> = {}
			const seen = new Set<string>()
			for (const r of ranges) {
				const item = await getRangeDataOnce({ ...r, ...(includeDisplay !== undefined ? { includeDisplay } : {}) })
				const key = String(item.requestedA1 ?? item.a1)
				byA1[key] = item
				if (!seen.has(key)) {
					seen.add(key)
					order.push(key)
				}
			}
			return { order, byA1 }
		},
	}

	const search_cells: AxFunction = {
		name: 'search_cells',
		description: getMcpToolDescription('search_cells'),
		parameters: asAxParams(SearchCellsSchema),
		func: async (input: UniverToolSearchCellsInput): Promise<UniverToolSearchCellsResult> => {
			ctx.stats.toolCalls++
			ctx.stats.readCalls++

			const { range, sheetName } = resolveRangeInput(input)
			const effSheetName = sheetName ?? input.sheetName ?? ctx.defaultSheetName
			const effSheetId = input.sheetId ?? (effSheetName ? ctx.sheetNameToId.get(effSheetName) : undefined) ?? ctx.defaultSheetId
			ctx.checkReadRange(range, effSheetId, effSheetName)

			const sheet = resolveSheet(ctx.workbook, effSheetId, effSheetName)
			const sheetId = getSheetId(sheet)
			const resolvedSheetName = getSheetName(sheet)
			const query = String(input.query ?? '')
			if (!query.trim()) throw new Error('[univer] query must be non-empty')
			const match = input.match ?? 'contains'
			const caseSensitive = input.caseSensitive ?? false
			const maxResults = normalizeCount(input.maxResults ?? 200, 1, 1000)
			const epoch = ctx.cache?.epoch ?? 0
			const cacheKey = `${epoch}|search_cells|${sheetId}|${range.startRow},${range.startCol},${range.endRow},${range.endCol}|${match}|${caseSensitive ? 1 : 0}|${maxResults}|${query}`
			const hit = ctx.cache?.get(cacheKey)
			if (hit !== undefined) return hit as UniverToolSearchCellsResult
			const r = sheet.getRange({
				startRow: range.startRow,
				startColumn: range.startCol,
				endRow: range.endRow,
				endColumn: range.endCol,
			})
			const matrix = toStringMatrix(r.getDisplayValues())

			const res: Array<{ sheetId: string; sheetName: string; a1: string; row: number; col: number; value: string }> = []
			let rx: RegExp | null = null
			if (match === 'regex') {
				try {
					rx = new RegExp(query, caseSensitive ? '' : 'i')
				} catch {
					throw new Error('[univer] invalid regex')
				}
			}

			for (let rIdx = 0; rIdx < matrix.length; rIdx++) {
				const row = matrix[rIdx] ?? []
				for (let cIdx = 0; cIdx < row.length; cIdx++) {
					const raw = row[cIdx] ?? ''
					const text = caseSensitive ? raw : raw.toLowerCase()
					const q = caseSensitive ? query : query.toLowerCase()
					const hit =
						match === 'exact'
							? text === q
							: match === 'regex'
								? !!rx?.test(raw)
								: text.includes(q)
					if (hit) {
						const absRow = range.startRow + rIdx
						const absCol = range.startCol + cIdx
						res.push({
							sheetId,
							sheetName: resolvedSheetName,
							a1: formatA1Range(resolvedSheetName, { startRow: absRow, startCol: absCol, endRow: absRow, endCol: absCol }),
							row: absRow,
							col: absCol,
							value: raw,
						})
						if (res.length >= maxResults) return { matches: res }
					}
				}
			}

			const out = { matches: res } satisfies UniverToolSearchCellsResult
			ctx.cache?.set(cacheKey, out)
			return out
		},
	}

	const auto_fill: AxFunction = {
		name: 'auto_fill',
		description: getMcpToolDescription('auto_fill'),
		parameters: asAxParams(AutoFillSchema),
		func: async (input: UniverToolAutoFillInput): Promise<UniverToolAutoFillResult> => {
			ctx.stats.toolCalls++

			const source = resolveRangeInput(input.source)
			const target = resolveRangeInput(input.target)
			const sourceSheetName = source.sheetName ?? input.source.sheetName
			const targetSheetName = target.sheetName ?? input.target.sheetName
			if (sourceSheetName && targetSheetName && sourceSheetName !== targetSheetName) {
				throw new Error('[univer] auto_fill requires source and target to be in the same sheet')
			}
			const effSheetName = sourceSheetName ?? targetSheetName ?? ctx.defaultSheetName
			const effSheetId =
				input.source.sheetId ??
				input.target.sheetId ??
				(effSheetName ? ctx.sheetNameToId.get(effSheetName) : undefined) ??
				ctx.defaultSheetId
			ctx.checkReadRange(source.range, effSheetId, effSheetName)
			ctx.checkWriteRange(target.range, effSheetId, effSheetName)

			const sheet = resolveSheet(ctx.workbook, effSheetId, effSheetName)

			const sourceRange = sheet.getRange({
				startRow: source.range.startRow,
				startColumn: source.range.startCol,
				endRow: source.range.endRow,
				endColumn: source.range.endCol,
			})
			const sourceValues = toMatrix(
				typeof sourceRange.getValues === 'function' ? sourceRange.getValues() : sourceRange.getDisplayValues(),
			)

			const targetRange = sheet.getRange({
				startRow: target.range.startRow,
				startColumn: target.range.startCol,
				endRow: target.range.endRow,
				endColumn: target.range.endCol,
			})
			const { rows, cols } = computeRangeSize(target.range)
			const tiled = tileMatrix(sourceValues, rows, cols)
			ctx.checkCanChange()
			ctx.checkCanApplyOps(rows * cols)
			targetRange.setValues(tiled)
			ctx.bumpChange()
			const updatedCells = rows * cols
			ctx.stats.appliedOps += updatedCells
			const wantReadback = !!input.readback
			if (!wantReadback) return { updatedCells }

			const includeDisplay = Boolean(input.readback?.includeDisplay)
			const sheetId = getSheetId(sheet)
			const resolvedSheetName = getSheetName(sheet)
			ctx.stats.readCalls++
			const item = await getRangeDataOnce({
				sheetId,
				sheetName: resolvedSheetName,
				range: target.range,
				...(includeDisplay ? { includeDisplay: true } : {}),
			})
			const key = String(item.requestedA1 ?? item.a1)
			return { updatedCells, readback: { order: [key], byA1: { [key]: item } } }
		},
	}

	const fill_formula: AxFunction = {
		name: 'fill_formula',
		description: getMcpToolDescription('fill_formula'),
		parameters: asAxParams(FillFormulaSchema),
		func: async (input: UniverToolFillFormulaInput): Promise<UniverToolFillFormulaResult> => {
			ctx.stats.toolCalls++

			const { range, sheetName } = resolveRangeInput(input)
			const effSheetName = sheetName ?? input.sheetName ?? ctx.defaultSheetName
			const effSheetId = input.sheetId ?? (effSheetName ? ctx.sheetNameToId.get(effSheetName) : undefined) ?? ctx.defaultSheetId
			ctx.checkWriteRange(range, effSheetId, effSheetName)

			const formula = String(input.formula ?? '')
			if (!formula.trim()) throw new Error('[univer] fill_formula formula must be non-empty')
			if (!formula.trim().startsWith('=')) throw new Error('[univer] fill_formula formula must start with "="')

			const sheet = resolveSheet(ctx.workbook, effSheetId, effSheetName)

			const { rows, cols } = computeRangeSize(range)
			if (!rows || !cols) return { updatedCells: 0 }

			const matrix: string[][] = []
			for (let r = 0; r < rows; r++) {
				const row: string[] = []
				for (let c = 0; c < cols; c++) {
					row.push(shiftFormulaA1(formula.trim(), r, c))
				}
				matrix.push(row)
			}

			ctx.checkCanChange()
			ctx.checkCanApplyOps(rows * cols)
			const targetRange = sheet.getRange({
				startRow: range.startRow,
				startColumn: range.startCol,
				endRow: range.endRow,
				endColumn: range.endCol,
			})
			targetRange.setValues(matrix)
			ctx.bumpChange()
			const updatedCells = rows * cols
			ctx.stats.appliedOps += updatedCells
			const wantReadback = !!input.readback
			if (!wantReadback) return { updatedCells }

			const includeDisplay = Boolean(input.readback?.includeDisplay)
			const sheetId = getSheetId(sheet)
			const resolvedSheetName = getSheetName(sheet)
			ctx.stats.readCalls++
			const item = await getRangeDataOnce({
				sheetId,
				sheetName: resolvedSheetName,
				range,
				...(includeDisplay ? { includeDisplay: true } : {}),
			})
			const key = String(item.requestedA1 ?? item.a1)
			return { updatedCells, readback: { order: [key], byA1: { [key]: item } } }
		},
	}

	return [set_range_data, set_ranges_data, get_range_data, get_ranges_data, search_cells, auto_fill, fill_formula]
}
