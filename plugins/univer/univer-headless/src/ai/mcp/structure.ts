import type { AxFunction } from '@ax-llm/ax'
import { Type } from '@sinclair/typebox'
import type {
	UniverToolDeleteColumnsInput,
	UniverToolDeleteColumnsResult,
	UniverToolDeleteRowsInput,
	UniverToolDeleteRowsResult,
	UniverToolInsertColumnsInput,
	UniverToolInsertColumnsResult,
	UniverToolInsertRowsInput,
	UniverToolInsertRowsResult,
	UniverToolSetCellDimensionsInput,
	UniverToolSetCellDimensionsResult,
	UniverToolSetMergeInput,
	UniverToolSetMergeResult,
} from '../../protocol'

import { getMcpToolDescription } from './catalog'
import type { McpContext } from './context'
import { callFirst, normalizeCount, resolveRangeInput, resolveSheet } from './utils'
import { asAxParams } from '../ax-params'
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
		description: getMcpToolDescription('insert_rows'),
		parameters: asAxParams(InsertRowsSchema),
		func: async (input: UniverToolInsertRowsInput): Promise<UniverToolInsertRowsResult> => {
			ctx.stats.toolCalls++
			ctx.checkCanChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(input.sheetId, input.name)
			const index = Math.max(0, Math.floor(input.index))
			const count = normalizeCount(input.count, 1, 1000)
			const res =
				callFirst(sheet, ['insertRows', 'insertRow'], index, count) ??
				callFirst(sheet, ['insertRows', 'insertRow'], index)
			if (res === undefined) throw new Error('[univer] insert rows not supported')
			ctx.bumpChange()
			return { ok: true }
		},
	}

	const insert_columns: AxFunction = {
		name: 'insert_columns',
		description: getMcpToolDescription('insert_columns'),
		parameters: asAxParams(InsertColumnsSchema),
		func: async (input: UniverToolInsertColumnsInput): Promise<UniverToolInsertColumnsResult> => {
			ctx.stats.toolCalls++
			ctx.checkCanChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(input.sheetId, input.name)
			const index = Math.max(0, Math.floor(input.index))
			const count = normalizeCount(input.count, 1, 1000)
			const res =
				callFirst(sheet, ['insertColumns', 'insertColumn'], index, count) ??
				callFirst(sheet, ['insertColumns', 'insertColumn'], index)
			if (res === undefined) throw new Error('[univer] insert columns not supported')
			ctx.bumpChange()
			return { ok: true }
		},
	}

	const delete_rows: AxFunction = {
		name: 'delete_rows',
		description: getMcpToolDescription('delete_rows'),
		parameters: asAxParams(DeleteRowsSchema),
		func: async (input: UniverToolDeleteRowsInput): Promise<UniverToolDeleteRowsResult> => {
			ctx.stats.toolCalls++
			ctx.checkCanChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(input.sheetId, input.name)
			const index = Math.max(0, Math.floor(input.index))
			const count = normalizeCount(input.count, 1, 1000)
			const res =
				callFirst(sheet, ['deleteRows', 'removeRows', 'deleteRow'], index, count) ??
				callFirst(sheet, ['deleteRows', 'removeRows', 'deleteRow'], index)
			if (res === undefined) throw new Error('[univer] delete rows not supported')
			ctx.bumpChange()
			return { ok: true }
		},
	}

	const delete_columns: AxFunction = {
		name: 'delete_columns',
		description: getMcpToolDescription('delete_columns'),
		parameters: asAxParams(DeleteColumnsSchema),
		func: async (input: UniverToolDeleteColumnsInput): Promise<UniverToolDeleteColumnsResult> => {
			ctx.stats.toolCalls++
			ctx.checkCanChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(input.sheetId, input.name)
			const index = Math.max(0, Math.floor(input.index))
			const count = normalizeCount(input.count, 1, 1000)
			const res =
				callFirst(sheet, ['deleteColumns', 'removeColumns', 'deleteColumn'], index, count) ??
				callFirst(sheet, ['deleteColumns', 'removeColumns', 'deleteColumn'], index)
			if (res === undefined) throw new Error('[univer] delete columns not supported')
			ctx.bumpChange()
			return { ok: true }
		},
	}

	const set_cell_dimensions: AxFunction = {
		name: 'set_cell_dimensions',
		description: getMcpToolDescription('set_cell_dimensions'),
		parameters: asAxParams(SetCellDimensionsSchema),
		func: async (input: UniverToolSetCellDimensionsInput): Promise<UniverToolSetCellDimensionsResult> => {
			ctx.stats.toolCalls++
			ctx.checkCanChange()

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

			ctx.bumpChange()
			return { ok: true }
		},
	}

	const set_merge: AxFunction = {
		name: 'set_merge',
		description: getMcpToolDescription('set_merge'),
		parameters: asAxParams(SetMergeSchema),
		func: async (input: UniverToolSetMergeInput): Promise<UniverToolSetMergeResult> => {
			ctx.stats.toolCalls++
			ctx.checkCanChange()

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
			ctx.bumpChange()
			return { ok: true }
		},
	}

	return [insert_rows, insert_columns, delete_rows, delete_columns, set_cell_dimensions, set_merge]
}
