import type { AxFunction } from '@ax-llm/ax'
import { Type } from '@sinclair/typebox'
import type {
	UniverAiRange,
	UniverMcpAutoFillInput,
	UniverMcpAutoFillResult,
	UniverMcpGetRangeDataInput,
	UniverMcpGetRangeDataResult,
	UniverMcpSearchCellsInput,
	UniverMcpSearchCellsResult,
	UniverMcpSetRangeDataInput,
	UniverMcpSetRangeDataResult,
} from '../../protocol'

import type { McpContext } from './context'
import { resolveRangeInput, resolveSheet, getSheetId, toMatrix, toStringMatrix, normalizeCount } from './utils'
const RangeSchema = Type.Object(
	{
		startRow: Type.Integer(),
		startCol: Type.Integer(),
		endRow: Type.Integer(),
		endCol: Type.Integer(),
	},
	{ additionalProperties: false },
)

const RangeInputProps = {
	sheetId: Type.Optional(Type.String()),
	sheetName: Type.Optional(Type.String()),
	a1: Type.Optional(Type.String()),
	range: Type.Optional(RangeSchema),
} as const

const RangeInputSchema = Type.Object(RangeInputProps, { additionalProperties: false })

const SetRangeDataSchema = Type.Object(
	{
		...RangeInputProps,
		values: Type.Array(Type.Array(Type.Any())),
	},
	{ additionalProperties: false },
)

const GetRangeDataSchema = Type.Object(
	{
		...RangeInputProps,
		includeDisplay: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
)

const SearchCellsSchema = Type.Object(
	{
		...RangeInputProps,
		query: Type.String(),
		match: Type.Optional(Type.Union([Type.Literal('contains'), Type.Literal('exact'), Type.Literal('regex')])),
		caseSensitive: Type.Optional(Type.Boolean()),
		maxResults: Type.Optional(Type.Integer()),
	},
	{ additionalProperties: false },
)

const AutoFillSchema = Type.Object(
	{
		source: RangeInputSchema,
		target: RangeInputSchema,
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

function computeRangeSize(range: UniverAiRange) {
	return {
		rows: Math.max(0, range.endRow - range.startRow + 1),
		cols: Math.max(0, range.endCol - range.startCol + 1),
	}
}

export function createDataTools(ctx: McpContext): AxFunction[] {
	const set_range_data: AxFunction = {
		name: 'set_range_data',
		description: 'Set values in a cell range.',
		parameters: SetRangeDataSchema,
		func: async (input: UniverMcpSetRangeDataInput): Promise<UniverMcpSetRangeDataResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const { range, sheetName } = resolveRangeInput(input)
			ctx.checkWriteRange(range, input.sheetId, sheetName ?? input.sheetName)

			const sheet = resolveSheet(ctx.workbook, input.sheetId, sheetName ?? input.sheetName)
			const values = toMatrix(input.values)
			const { rows, cols } = computeRangeSize(range)
			if (!rows || !cols) return { updatedCells: 0 }

			const r = sheet.getRange({
				startRow: range.startRow,
				startColumn: range.startCol,
				endRow: range.endRow,
				endColumn: range.endCol,
			})
			r.setValues(values as any)
			const updatedCells = rows * cols
			ctx.stats.appliedOps += updatedCells
			return { updatedCells }
		},
	}

	const get_range_data: AxFunction = {
		name: 'get_range_data',
		description: 'Read raw values in a cell range.',
		parameters: GetRangeDataSchema,
		func: async (input: UniverMcpGetRangeDataInput): Promise<UniverMcpGetRangeDataResult> => {
			ctx.stats.toolCalls++
			ctx.stats.readCalls++

			const { range, sheetName, a1 } = resolveRangeInput(input)
			ctx.checkReadRange(range, input.sheetId, sheetName ?? input.sheetName)

			const sheet = resolveSheet(ctx.workbook, input.sheetId, sheetName ?? input.sheetName)
			const sheetId = getSheetId(sheet)

			const r = sheet.getRange({
				startRow: range.startRow,
				startColumn: range.startCol,
				endRow: range.endRow,
				endColumn: range.endCol,
			})
			const values = typeof r.getValues === 'function' ? r.getValues() : r.getDisplayValues()
			const res: UniverMcpGetRangeDataResult = {
				sheetId,
				a1,
				range,
				values: toMatrix(values),
			}
			if (input.includeDisplay) res.displayValues = toStringMatrix(r.getDisplayValues())
			return res
		},
	}

	const search_cells: AxFunction = {
		name: 'search_cells',
		description: 'Search for content in a cell range.',
		parameters: SearchCellsSchema,
		func: async (input: UniverMcpSearchCellsInput): Promise<UniverMcpSearchCellsResult> => {
			ctx.stats.toolCalls++
			ctx.stats.readCalls++

			const { range, sheetName } = resolveRangeInput(input)
			ctx.checkReadRange(range, input.sheetId, sheetName ?? input.sheetName)

			const sheet = resolveSheet(ctx.workbook, input.sheetId, sheetName ?? input.sheetName)
			const sheetId = getSheetId(sheet)
			const r = sheet.getRange({
				startRow: range.startRow,
				startColumn: range.startCol,
				endRow: range.endRow,
				endColumn: range.endCol,
			})
			const matrix = toStringMatrix(r.getDisplayValues())
			const query = String(input.query ?? '')
			if (!query.trim()) throw new Error('[univer] query must be non-empty')
			const match = input.match ?? 'contains'
			const caseSensitive = input.caseSensitive ?? false
			const maxResults = normalizeCount(input.maxResults ?? 200, 1, 1000)

			const res: Array<{ sheetId: string; row: number; col: number; value: string }> = []
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
						res.push({
							sheetId,
							row: range.startRow + rIdx,
							col: range.startCol + cIdx,
							value: raw,
						})
						if (res.length >= maxResults) return { matches: res }
					}
				}
			}

			return { matches: res }
		},
	}

	const auto_fill: AxFunction = {
		name: 'auto_fill',
		description: 'Auto-fill target range by tiling source values.',
		parameters: AutoFillSchema,
		func: async (input: UniverMcpAutoFillInput): Promise<UniverMcpAutoFillResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const source = resolveRangeInput(input.source)
			const target = resolveRangeInput(input.target)
			ctx.checkReadRange(source.range, input.source.sheetId, source.sheetName ?? input.source.sheetName)
			ctx.checkWriteRange(target.range, input.target.sheetId, target.sheetName ?? input.target.sheetName)

			const sheet = resolveSheet(
				ctx.workbook,
				input.target.sheetId ?? input.source.sheetId,
				target.sheetName ?? input.target.sheetName ?? source.sheetName ?? input.source.sheetName,
			)

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
			targetRange.setValues(tiled as any)
			const updatedCells = rows * cols
			ctx.stats.appliedOps += updatedCells
			return { updatedCells }
		},
	}

	return [set_range_data, get_range_data, search_cells, auto_fill]
}
