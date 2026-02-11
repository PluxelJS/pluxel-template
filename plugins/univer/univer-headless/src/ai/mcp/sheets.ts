import type { AxFunction } from '@ax-llm/ax'
import { Type } from '@sinclair/typebox'
import type {
	UniverToolActivateSheetInput,
	UniverToolActivateSheetResult,
	UniverToolCreateSheetInput,
	UniverToolCreateSheetResult,
	UniverToolDeleteSheetInput,
	UniverToolDeleteSheetResult,
	UniverToolGetActiveUnitIdResult,
	UniverToolGetActivityStatusResult,
	UniverToolGetSheetsResult,
	UniverToolMoveSheetInput,
	UniverToolMoveSheetResult,
	UniverToolRenameSheetInput,
	UniverToolRenameSheetResult,
	UniverToolSetSheetDisplayStatusInput,
	UniverToolSetSheetDisplayStatusResult,
} from '../../protocol'

import { getMcpToolDescription } from './catalog'
import type { McpContext } from './context'
import { callFirst, getSheetId, getSheetName, resolveSheet } from './utils'
const EmptySchema = Type.Object({}, { additionalProperties: false })

const CreateSheetSchema = Type.Object(
	{
		name: Type.Optional(Type.String()),
		index: Type.Optional(Type.Integer()),
	},
	{ additionalProperties: false },
)

const DeleteSheetSchema = Type.Object(
	{
		sheetId: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
)

const RenameSheetSchema = Type.Object(
	{
		sheetId: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		newName: Type.String(),
	},
	{ additionalProperties: false },
)

const ActivateSheetSchema = Type.Object(
	{
		sheetId: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
)

const MoveSheetSchema = Type.Object(
	{
		sheetId: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		index: Type.Integer(),
	},
	{ additionalProperties: false },
)

const SetSheetDisplayStatusSchema = Type.Object(
	{
		sheetId: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		hidden: Type.Boolean(),
	},
	{ additionalProperties: false },
)

function listSheets(workbook: any) {
	const sheets = (workbook?.getSheets?.() ?? []) as any[]
	return sheets.map((s, index) => {
		let hidden: boolean | undefined
		try {
			if (typeof s?.isHidden === 'function') hidden = !!s.isHidden()
		} catch {}
		return { sheetId: getSheetId(s), name: getSheetName(s), index, hidden }
	})
}

function resolveSheetFromInput(workbook: any, sheetId?: string, name?: string) {
	if (sheetId || name) return resolveSheet(workbook, sheetId, name)
	return resolveSheet(workbook)
}

export function createSheetTools(ctx: McpContext): AxFunction[] {
	const get_sheets: AxFunction = {
		name: 'get_sheets',
		description: getMcpToolDescription('get_sheets'),
		parameters: EmptySchema,
		func: async (): Promise<UniverToolGetSheetsResult> => {
			ctx.stats.toolCalls++
			return { sheets: listSheets(ctx.workbook) }
		},
	}

	const get_active_unit_id: AxFunction = {
		name: 'get_active_unit_id',
		description: getMcpToolDescription('get_active_unit_id'),
		parameters: EmptySchema,
		func: async (): Promise<UniverToolGetActiveUnitIdResult> => {
			ctx.stats.toolCalls++
			const workbookId = typeof ctx.workbook?.getId === 'function' ? String(ctx.workbook.getId()) : null
			const active = ctx.workbook?.getActiveSheet?.()
			const activeSheetId = active ? getSheetId(active) : null
			return { workbookId, activeSheetId }
		},
	}

	const get_activity_status: AxFunction = {
		name: 'get_activity_status',
		description: getMcpToolDescription('get_activity_status'),
		parameters: EmptySchema,
		func: async (): Promise<UniverToolGetActivityStatusResult> => {
			ctx.stats.toolCalls++
			const workbookId = typeof ctx.workbook?.getId === 'function' ? String(ctx.workbook.getId()) : null
			const active = ctx.workbook?.getActiveSheet?.()
			const activeSheetId = active ? getSheetId(active) : null
			const sheets = ctx.workbook?.getSheets?.() ?? []
			return { workbookId, activeSheetId, sheetCount: Array.isArray(sheets) ? sheets.length : 0 }
		},
	}

	const create_sheet: AxFunction = {
		name: 'create_sheet',
		description: getMcpToolDescription('create_sheet'),
		parameters: CreateSheetSchema,
		func: async (input: UniverToolCreateSheetInput): Promise<UniverToolCreateSheetResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()
			ctx.checkWriteSheet()

			const name = typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : undefined
			const index = typeof input?.index === 'number' && Number.isFinite(input.index) ? Math.floor(input.index) : undefined

			const sheet =
				callFirst(ctx.workbook, ['createSheet', 'addSheet', 'insertSheet', 'createWorksheet', 'insertWorksheet'], name, index) ??
				callFirst(ctx.workbook, ['createSheet', 'addSheet', 'insertSheet', 'createWorksheet', 'insertWorksheet'], name)

			if (sheet) {
				return { sheetId: getSheetId(sheet), name: getSheetName(sheet) }
			}

			// Fallback: best-effort lookup by name.
			if (name) {
				const byName = ctx.workbook?.getSheetByName?.(name)
				if (byName) return { sheetId: getSheetId(byName), name: getSheetName(byName) }
			}

			throw new Error('[univer] create sheet not supported')
		},
	}

	const delete_sheet: AxFunction = {
		name: 'delete_sheet',
		description: getMcpToolDescription('delete_sheet'),
		parameters: DeleteSheetSchema,
		func: async (input: UniverToolDeleteSheetInput): Promise<UniverToolDeleteSheetResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(getSheetId(sheet), getSheetName(sheet))
			const sheetId = getSheetId(sheet)
			const res =
				callFirst(ctx.workbook, ['deleteSheet', 'removeSheet', 'disposeSheet', 'deleteWorksheet', 'removeWorksheet'], sheetId) ??
				callFirst(ctx.workbook, ['deleteSheet', 'removeSheet', 'disposeSheet', 'deleteWorksheet', 'removeWorksheet'], sheet)
			if (res === undefined) {
				if (typeof sheet?.dispose === 'function') sheet.dispose()
				else throw new Error('[univer] delete sheet not supported')
			}
			return { ok: true }
		},
	}

	const rename_sheet: AxFunction = {
		name: 'rename_sheet',
		description: getMcpToolDescription('rename_sheet'),
		parameters: RenameSheetSchema,
		func: async (input: UniverToolRenameSheetInput): Promise<UniverToolRenameSheetResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(getSheetId(sheet), getSheetName(sheet))
			const newName = String(input.newName ?? '').trim()
			if (!newName) throw new Error('[univer] newName must be non-empty')

			const res =
				callFirst(sheet, ['setName', 'rename', 'setSheetName'], newName) ??
				callFirst(ctx.workbook, ['renameSheet', 'setSheetName'], getSheetId(sheet), newName)
			if (res === undefined) throw new Error('[univer] rename sheet not supported')

			return { sheetId: getSheetId(sheet), name: getSheetName(sheet) }
		},
	}

	const activate_sheet: AxFunction = {
		name: 'activate_sheet',
		description: getMcpToolDescription('activate_sheet'),
		parameters: ActivateSheetSchema,
		func: async (input: UniverToolActivateSheetInput): Promise<UniverToolActivateSheetResult> => {
			ctx.stats.toolCalls++
			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			const sheetId = getSheetId(sheet)
			const res = callFirst(ctx.workbook, ['setActiveSheet', 'activateSheet'], sheetId)
			if (res === undefined) throw new Error('[univer] activate sheet not supported')
			return { ok: true, activeSheetId: sheetId }
		},
	}

	const move_sheet: AxFunction = {
		name: 'move_sheet',
		description: getMcpToolDescription('move_sheet'),
		parameters: MoveSheetSchema,
		func: async (input: UniverToolMoveSheetInput): Promise<UniverToolMoveSheetResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(getSheetId(sheet), getSheetName(sheet))
			const index = Math.max(0, Math.floor(input.index))
			const res =
				callFirst(ctx.workbook, ['moveSheet', 'moveWorksheet'], getSheetId(sheet), index) ??
				callFirst(ctx.workbook, ['moveSheet', 'moveWorksheet'], sheet, index)
			if (res === undefined) throw new Error('[univer] move sheet not supported')
			return { ok: true }
		},
	}

	const set_sheet_display_status: AxFunction = {
		name: 'set_sheet_display_status',
		description: getMcpToolDescription('set_sheet_display_status'),
		parameters: SetSheetDisplayStatusSchema,
		func: async (input: UniverToolSetSheetDisplayStatusInput): Promise<UniverToolSetSheetDisplayStatusResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const sheet = resolveSheetFromInput(ctx.workbook, input.sheetId, input.name)
			ctx.checkWriteSheet(getSheetId(sheet), getSheetName(sheet))
			const hidden = !!input.hidden
			const res =
				callFirst(sheet, ['setHidden'], hidden) ??
				callFirst(ctx.workbook, ['setSheetHidden'], getSheetId(sheet), hidden) ??
				callFirst(ctx.workbook, [hidden ? 'hideSheet' : 'showSheet'], getSheetId(sheet))
			if (res === undefined) throw new Error('[univer] set sheet display status not supported')
			return { ok: true }
		},
	}

	return [
		get_sheets,
		get_active_unit_id,
		get_activity_status,
		create_sheet,
		delete_sheet,
		rename_sheet,
		activate_sheet,
		move_sheet,
		set_sheet_display_status,
	]
}
