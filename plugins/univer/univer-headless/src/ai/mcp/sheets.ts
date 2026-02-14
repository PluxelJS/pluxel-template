import type { AxFunction } from '@ax-llm/ax'
import { Type } from '@sinclair/typebox'
import type {
	UniverToolGetActiveUnitIdResult,
	UniverToolGetActivityStatusResult,
	UniverToolGetSheetsResult,
} from '../../protocol'

import { getMcpToolDescription } from './catalog'
import type { McpContext } from './context'
import { getSheetId, getSheetName } from './utils'
import { coerceSheets, unwrapSheetEntry } from '../sheets-utils'
import { asAxParams } from '../ax-params'
const EmptySchema = Type.Object({}, { additionalProperties: false })

function listSheets(workbook: any) {
	const raw = typeof workbook?.getSheets === 'function' ? workbook.getSheets() : null
	const sheets = coerceSheets(raw)
	return sheets.map((entry: any, index: number) => {
		const s = unwrapSheetEntry(entry)
		let hidden: boolean | undefined
		try {
			if (typeof s?.isHidden === 'function') hidden = !!s.isHidden()
		} catch {}
		return { sheetId: getSheetId(s), name: getSheetName(s), index, hidden }
	})
}

export function createSheetTools(ctx: McpContext): AxFunction[] {
	const get_sheets: AxFunction = {
		name: 'get_sheets',
		description: getMcpToolDescription('get_sheets'),
		parameters: asAxParams(EmptySchema),
		func: async (): Promise<UniverToolGetSheetsResult> => {
			ctx.stats.toolCalls++
			return { sheets: listSheets(ctx.workbook) }
		},
	}

	const get_active_unit_id: AxFunction = {
		name: 'get_active_unit_id',
		description: getMcpToolDescription('get_active_unit_id'),
		parameters: asAxParams(EmptySchema),
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
		parameters: asAxParams(EmptySchema),
		func: async (): Promise<UniverToolGetActivityStatusResult> => {
			ctx.stats.toolCalls++
			const workbookId = typeof ctx.workbook?.getId === 'function' ? String(ctx.workbook.getId()) : null
			const active = ctx.workbook?.getActiveSheet?.()
			const activeSheetId = active ? getSheetId(active) : null
			const raw = typeof ctx.workbook?.getSheets === 'function' ? ctx.workbook.getSheets() : null
			const sheetCount = Array.isArray(raw)
				? raw.length
				: raw && typeof raw?.size === 'number' && Number.isFinite(raw.size)
					? Math.floor(raw.size)
					: raw && typeof raw?.length === 'number' && Number.isFinite(raw.length)
						? Math.floor(raw.length)
						: raw && typeof raw?.values === 'function'
							? listSheets(ctx.workbook).length
							: 0
			return { workbookId, activeSheetId, sheetCount }
		},
	}
	return [get_sheets, get_active_unit_id, get_activity_status]
}
