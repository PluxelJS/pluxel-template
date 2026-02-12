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
import { asAxParams } from '../ax-params'
const RangeSchema = Type.Object(
	{
		startRow: Type.Integer(),
		startCol: Type.Integer(),
		endRow: Type.Integer(),
		endCol: Type.Integer(),
	},
	{ additionalProperties: false },
)

const RangeInputBaseProps = {
	sheetId: Type.Optional(Type.String()),
	sheetName: Type.Optional(Type.String()),
} as const

const A1RangeRefSchema = Type.Object(
	{
		...RangeInputBaseProps,
		a1: Type.String(),
	},
	{ additionalProperties: false },
)

const IndexRangeRefSchema = Type.Object(
	{
		...RangeInputBaseProps,
		range: RangeSchema,
	},
	{ additionalProperties: false },
)

const RangeInputSchema = Type.Union([A1RangeRefSchema, IndexRangeRefSchema])

const SetRangeDataSchema = Type.Union([
	Type.Object(
		{
			...RangeInputBaseProps,
			a1: Type.String(),
			values: Type.Array(Type.Array(Type.Any())),
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
	),
	Type.Object(
		{
			...RangeInputBaseProps,
			range: RangeSchema,
			values: Type.Array(Type.Array(Type.Any())),
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
	),
])

const GetRangeDataSchema = Type.Union([
	Type.Object(
		{
			...RangeInputBaseProps,
			a1: Type.String(),
			includeDisplay: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...RangeInputBaseProps,
			range: RangeSchema,
			includeDisplay: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
])

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

const SearchCellsSchema = Type.Union([
	Type.Object(
		{
			...RangeInputBaseProps,
			a1: Type.String(),
			query: Type.String(),
			match: Type.Optional(Type.Union([Type.Literal('contains'), Type.Literal('exact'), Type.Literal('regex')])),
			caseSensitive: Type.Optional(Type.Boolean()),
			maxResults: Type.Optional(Type.Integer()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...RangeInputBaseProps,
			range: RangeSchema,
			query: Type.String(),
			match: Type.Optional(Type.Union([Type.Literal('contains'), Type.Literal('exact'), Type.Literal('regex')])),
			caseSensitive: Type.Optional(Type.Boolean()),
			maxResults: Type.Optional(Type.Integer()),
		},
		{ additionalProperties: false },
	),
])

const AutoFillSchema = Type.Object(
	{
		source: RangeInputSchema,
		target: RangeInputSchema,
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

const FillFormulaSchema = Type.Union([
	Type.Object(
		{
			...RangeInputBaseProps,
			a1: Type.String(),
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
	),
	Type.Object(
		{
			...RangeInputBaseProps,
			range: RangeSchema,
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
	),
])

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
	const validateAndNormalizeValues = (inputValues: unknown, expectedRows: number, expectedCols: number) => {
		if (!Array.isArray(inputValues)) {
			throw new Error('[univer] set_range_data invalid values: expected a 2D array (matrix)')
		}

		let values = toMatrix(inputValues)
		const gotRows = values.length
		const gotCols = Math.max(0, ...values.map((r) => (Array.isArray(r) ? r.length : 0)))
		const expected = `${expectedRows}x${expectedCols}`
		const got = `${gotRows}x${gotCols}`

		// Univer's Range#setValues expects a dense 2D matrix. If we pass a wrong shape, it may crash internally.
		// We only auto-expand a single scalar value for convenience (common for constants).
		if (gotRows !== expectedRows || gotCols !== expectedCols || values.some((r) => r.length !== expectedCols)) {
			if (gotRows === 1 && gotCols === 1) {
				const v = values[0]?.[0]
				if (typeof v === 'string' && v.trim().startsWith('=') && expectedRows * expectedCols > 1) {
					throw new Error(
						`[univer] set_range_data invalid values matrix: got ${got} but expected ${expected}. For formulas, provide a full ${expected} matrix (each cell can have its own formula string).`,
					)
				}
				values = Array.from({ length: expectedRows }, () => Array.from({ length: expectedCols }, () => v))
			} else {
				throw new Error(
					`[univer] set_range_data invalid values matrix: got ${got} but expected ${expected}. Provide a full ${expected} matrix.`,
				)
			}
		}

		return values
	}

	const getRangeDataOnce = async (input: UniverToolGetRangeDataInput): Promise<UniverToolGetRangeDataResult> => {
		const { range: origRange, sheetName, a1 } = resolveRangeInput(input)
		const effSheetId = input.sheetId ?? ctx.defaultSheetId
		const effSheetName = sheetName ?? input.sheetName ?? ctx.defaultSheetName
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

			const { range, sheetName } = resolveRangeInput(input)
			ctx.checkWriteRange(range, input.sheetId, sheetName ?? input.sheetName)

			const sheet = resolveSheet(
				ctx.workbook,
				input.sheetId ?? ctx.defaultSheetId,
				sheetName ?? input.sheetName ?? ctx.defaultSheetName,
			)
			const { rows, cols } = computeRangeSize(range)
			if (!rows || !cols) return { updatedCells: 0 }

			const values = validateAndNormalizeValues(input.values, rows, cols)

			ctx.checkCanChange()
			ctx.checkCanApplyOps(rows * cols)
			const r = sheet.getRange({
				startRow: range.startRow,
				startColumn: range.startCol,
				endRow: range.endRow,
				endColumn: range.endCol,
			})
			r.setValues(values)
			ctx.bumpChange()
			const updatedCells = rows * cols
			ctx.stats.appliedOps += updatedCells
			const wantReadback = !!input.readback
			if (!wantReadback) return { updatedCells }

			const includeDisplay = Boolean(input.readback?.includeDisplay)
			const effSheetId = input.sheetId ?? ctx.defaultSheetId
			const effSheetName = sheetName ?? input.sheetName ?? ctx.defaultSheetName
			ctx.stats.readCalls++
			const item = await getRangeDataOnce({
				...(effSheetId ? { sheetId: effSheetId } : {}),
				...(effSheetName ? { sheetName: effSheetName } : {}),
				range,
				...(includeDisplay ? { includeDisplay: true } : {}),
			})
			const key = String(item.requestedA1 ?? item.a1)
			return { updatedCells, readback: { order: [key], byA1: { [key]: item } } }
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
			}
			const resolved: ResolvedUpdate[] = []
			let totalCells = 0

			for (const u of updates) {
				const { range, sheetName } = resolveRangeInput(u)
				ctx.checkWriteRange(range, u.sheetId, sheetName ?? u.sheetName)
				const sheet = resolveSheet(
					ctx.workbook,
					u.sheetId ?? ctx.defaultSheetId,
					sheetName ?? u.sheetName ?? ctx.defaultSheetName,
				)
				const resolvedSheetId = getSheetId(sheet)
				const resolvedSheetName = getSheetName(sheet)
				const { rows, cols } = computeRangeSize(range)
				if (!rows || !cols) continue
				const values = validateAndNormalizeValues(u.values, rows, cols)
				const updatedCells = rows * cols
				totalCells += updatedCells
				resolved.push({ range, sheet, sheetId: resolvedSheetId, sheetName: resolvedSheetName, values, updatedCells })
			}

			if (!resolved.length) return { updates: 0, updatedCells: 0 }

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
			if (!wantReadback) return { updates: resolved.length, updatedCells: totalCells }

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
			const effSheetId = input.sheetId ?? ctx.defaultSheetId
			const effSheetName = sheetName ?? input.sheetName ?? ctx.defaultSheetName
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
			const effSheetId = input.target.sheetId ?? input.source.sheetId ?? ctx.defaultSheetId
			const effSheetName =
				target.sheetName ?? input.target.sheetName ?? source.sheetName ?? input.source.sheetName ?? ctx.defaultSheetName
			ctx.checkReadRange(source.range, input.source.sheetId ?? effSheetId, source.sheetName ?? input.source.sheetName ?? effSheetName)
			ctx.checkWriteRange(target.range, input.target.sheetId ?? effSheetId, target.sheetName ?? input.target.sheetName ?? effSheetName)

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
			ctx.checkWriteRange(range, input.sheetId, sheetName ?? input.sheetName)

			const formula = String(input.formula ?? '')
			if (!formula.trim()) throw new Error('[univer] fill_formula formula must be non-empty')
			if (!formula.trim().startsWith('=')) throw new Error('[univer] fill_formula formula must start with "="')

			const sheet = resolveSheet(
				ctx.workbook,
				input.sheetId ?? ctx.defaultSheetId,
				sheetName ?? input.sheetName ?? ctx.defaultSheetName,
			)

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
