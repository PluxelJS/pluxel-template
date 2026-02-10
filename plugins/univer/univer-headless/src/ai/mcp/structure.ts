import type { AxFunction } from '@ax-llm/ax'
import { Type } from '@sinclair/typebox'
import type {
	UniverMcpDeleteColumnsInput,
	UniverMcpDeleteColumnsResult,
	UniverMcpDeleteRowsInput,
	UniverMcpDeleteRowsResult,
	UniverMcpInsertColumnsInput,
	UniverMcpInsertColumnsResult,
	UniverMcpInsertRowsInput,
	UniverMcpInsertRowsResult,
	UniverMcpSetCellDimensionsInput,
	UniverMcpSetCellDimensionsResult,
	UniverMcpSetMergeInput,
	UniverMcpSetMergeResult,
} from '../../protocol'

import type { McpContext } from './context'
import { callFirst, normalizeCount, resolveRangeInput, resolveSheet } from './utils'
const InsertRowsSchema = Type.Object(
	{
		sheetId: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		index: Type.Integer(),
		count: Type.Integer(),
	},
	{ additionalProperties: false },
)

const InsertColumnsSchema = Type.Object(
	{
		sheetId: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		index: Type.Integer(),
		count: Type.Integer(),
	},
	{ additionalProperties: false },
)

const DeleteRowsSchema = Type.Object(
	{
		sheetId: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		index: Type.Integer(),
		count: Type.Integer(),
	},
	{ additionalProperties: false },
)

const DeleteColumnsSchema = Type.Object(
	{
		sheetId: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		index: Type.Integer(),
		count: Type.Integer(),
	},
	{ additionalProperties: false },
)

const SetCellDimensionsSchema = Type.Object(
	{
		sheetId: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		rows: Type.Optional(
			Type.Object(
				{
					startRow: Type.Integer(),
					endRow: Type.Integer(),
					height: Type.Number(),
				},
				{ additionalProperties: false },
			),
		),
		cols: Type.Optional(
			Type.Object(
				{
					startCol: Type.Integer(),
					endCol: Type.Integer(),
					width: Type.Number(),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
)

const SetMergeSchema = Type.Object(
	{
		sheetId: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		range: Type.Object(
			{
				startRow: Type.Integer(),
				startCol: Type.Integer(),
				endRow: Type.Integer(),
				endCol: Type.Integer(),
			},
			{ additionalProperties: false },
		),
		merge: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
)

function resolveSheetFromInput(workbook: any, sheetId?: string, name?: string) {
	if (sheetId || name) return resolveSheet(workbook, sheetId, name)
	return resolveSheet(workbook)
}

export function createStructureTools(ctx: McpContext): AxFunction[] {
	const insert_rows: AxFunction = {
		name: 'insert_rows',
		description: 'Insert rows into a worksheet.',
		parameters: InsertRowsSchema,
		func: async (input: UniverMcpInsertRowsInput): Promise<UniverMcpInsertRowsResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(input.sheetId, input.name)
			const index = Math.max(0, Math.floor(input.index))
			const count = normalizeCount(input.count, 1, 1000)
			const res =
				callFirst(sheet, ['insertRows', 'insertRow'], index, count) ??
				callFirst(sheet, ['insertRows', 'insertRow'], index)
			if (res === undefined) throw new Error('[univer] insert rows not supported')
			return { ok: true }
		},
	}

	const insert_columns: AxFunction = {
		name: 'insert_columns',
		description: 'Insert columns into a worksheet.',
		parameters: InsertColumnsSchema,
		func: async (input: UniverMcpInsertColumnsInput): Promise<UniverMcpInsertColumnsResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(input.sheetId, input.name)
			const index = Math.max(0, Math.floor(input.index))
			const count = normalizeCount(input.count, 1, 1000)
			const res =
				callFirst(sheet, ['insertColumns', 'insertColumn'], index, count) ??
				callFirst(sheet, ['insertColumns', 'insertColumn'], index)
			if (res === undefined) throw new Error('[univer] insert columns not supported')
			return { ok: true }
		},
	}

	const delete_rows: AxFunction = {
		name: 'delete_rows',
		description: 'Delete rows in a worksheet.',
		parameters: DeleteRowsSchema,
		func: async (input: UniverMcpDeleteRowsInput): Promise<UniverMcpDeleteRowsResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(input.sheetId, input.name)
			const index = Math.max(0, Math.floor(input.index))
			const count = normalizeCount(input.count, 1, 1000)
			const res =
				callFirst(sheet, ['deleteRows', 'removeRows', 'deleteRow'], index, count) ??
				callFirst(sheet, ['deleteRows', 'removeRows', 'deleteRow'], index)
			if (res === undefined) throw new Error('[univer] delete rows not supported')
			return { ok: true }
		},
	}

	const delete_columns: AxFunction = {
		name: 'delete_columns',
		description: 'Delete columns in a worksheet.',
		parameters: DeleteColumnsSchema,
		func: async (input: UniverMcpDeleteColumnsInput): Promise<UniverMcpDeleteColumnsResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(input.sheetId, input.name)
			const index = Math.max(0, Math.floor(input.index))
			const count = normalizeCount(input.count, 1, 1000)
			const res =
				callFirst(sheet, ['deleteColumns', 'removeColumns', 'deleteColumn'], index, count) ??
				callFirst(sheet, ['deleteColumns', 'removeColumns', 'deleteColumn'], index)
			if (res === undefined) throw new Error('[univer] delete columns not supported')
			return { ok: true }
		},
	}

	const set_cell_dimensions: AxFunction = {
		name: 'set_cell_dimensions',
		description: 'Set row heights and column widths.',
		parameters: SetCellDimensionsSchema,
		func: async (input: UniverMcpSetCellDimensionsInput): Promise<UniverMcpSetCellDimensionsResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(input.sheetId, input.name)
			const rows = input.rows
			const cols = input.cols
			if (!rows && !cols) throw new Error('[univer] rows or cols required')

			if (rows) {
				const start = Math.max(0, Math.floor(rows.startRow))
				const end = Math.max(start, Math.floor(rows.endRow))
				const height = Number(rows.height)
				for (let r = start; r <= end; r++) {
					const res = callFirst(sheet, ['setRowHeight', 'setRowHeights'], r, height)
					if (res === undefined) throw new Error('[univer] set row height not supported')
				}
			}
			if (cols) {
				const start = Math.max(0, Math.floor(cols.startCol))
				const end = Math.max(start, Math.floor(cols.endCol))
				const width = Number(cols.width)
				for (let c = start; c <= end; c++) {
					const res = callFirst(sheet, ['setColumnWidth', 'setColumnWidths'], c, width)
					if (res === undefined) throw new Error('[univer] set column width not supported')
				}
			}

			return { ok: true }
		},
	}

	const set_merge: AxFunction = {
		name: 'set_merge',
		description: 'Merge or unmerge a cell range.',
		parameters: SetMergeSchema,
		func: async (input: UniverMcpSetMergeInput): Promise<UniverMcpSetMergeResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(input.sheetId, input.name)
			const merge = input.merge !== false
			const { range } = resolveRangeInput({ range: input.range })
			ctx.checkWriteRange(range, input.sheetId, input.name)

			const r = sheet.getRange({
				startRow: range.startRow,
				startColumn: range.startCol,
				endRow: range.endRow,
				endColumn: range.endCol,
			})
			const res = merge
				? callFirst(r, ['merge', 'mergeCells'])
				: callFirst(r, ['unmerge', 'unmergeCells']) ?? callFirst(sheet, ['unmergeCells'], range)
			if (res === undefined) throw new Error('[univer] merge not supported')
			return { ok: true }
		},
	}

	return [insert_rows, insert_columns, delete_rows, delete_columns, set_cell_dimensions, set_merge]
}
