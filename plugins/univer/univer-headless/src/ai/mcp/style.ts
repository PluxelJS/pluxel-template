import type { AxFunction } from '@ax-llm/ax'
import { Type } from '@sinclair/typebox'
import type {
	UniverToolFormatBrushInput,
	UniverToolFormatBrushResult,
	UniverToolSetRangeStyleInput,
	UniverToolSetRangeStyleResult,
} from '../../protocol'

import { getMcpToolDescription } from './catalog'
import type { McpContext } from './context'
import { resolveRangeInput, resolveSheet } from './utils'
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

const SetRangeStyleSchema = Type.Object(
	{
		...A1RangeSchema.properties,
		style: Type.Object({}, { additionalProperties: true }),
	},
	{ additionalProperties: false },
)

const FormatBrushSchema = Type.Object(
	{
		source: A1RangeSchema,
		target: A1RangeSchema,
	},
	{ additionalProperties: false },
)

export function createStyleTools(ctx: McpContext): AxFunction[] {
	const set_range_style: AxFunction = {
		name: 'set_range_style',
		description: getMcpToolDescription('set_range_style'),
		parameters: asAxParams(SetRangeStyleSchema),
		func: async (input: UniverToolSetRangeStyleInput): Promise<UniverToolSetRangeStyleResult> => {
			ctx.stats.toolCalls++

			const { range, sheetName } = resolveRangeInput(input)
			const effSheetName = sheetName ?? input.sheetName ?? ctx.defaultSheetName
			const effSheetId = input.sheetId ?? (effSheetName ? ctx.sheetNameToId.get(effSheetName) : undefined) ?? ctx.defaultSheetId
			ctx.checkWriteRange(range, effSheetId, effSheetName)

			const sheet = resolveSheet(ctx.workbook, effSheetId, effSheetName)
			const r = sheet.getRange({
				startRow: range.startRow,
				startColumn: range.startCol,
				endRow: range.endRow,
				endColumn: range.endCol,
			})
			ctx.checkCanChange()
			const res = r.setStyle?.(input.style) ?? r.setCellStyle?.(input.style)
			if (res === undefined) throw new Error('[univer] set style not supported')
			ctx.bumpChange()
			return { ok: true }
		},
	}

	const format_brush: AxFunction = {
		name: 'format_brush',
		description: getMcpToolDescription('format_brush'),
		parameters: asAxParams(FormatBrushSchema),
		func: async (input: UniverToolFormatBrushInput): Promise<UniverToolFormatBrushResult> => {
			ctx.stats.toolCalls++

			const source = resolveRangeInput(input.source)
			const target = resolveRangeInput(input.target)
			const sourceSheetName = source.sheetName ?? input.source.sheetName ?? ctx.defaultSheetName
			const targetSheetName = target.sheetName ?? input.target.sheetName ?? ctx.defaultSheetName
			const sourceSheetId =
				input.source.sheetId ?? (sourceSheetName ? ctx.sheetNameToId.get(sourceSheetName) : undefined) ?? ctx.defaultSheetId
			const targetSheetId =
				input.target.sheetId ?? (targetSheetName ? ctx.sheetNameToId.get(targetSheetName) : undefined) ?? ctx.defaultSheetId
			ctx.checkReadRange(source.range, sourceSheetId, sourceSheetName)
			ctx.checkWriteRange(target.range, targetSheetId, targetSheetName)

			const sourceSheet = resolveSheet(ctx.workbook, sourceSheetId, sourceSheetName)
			const targetSheet = resolveSheet(ctx.workbook, targetSheetId, targetSheetName)

			const srcRange = sourceSheet.getRange({
				startRow: source.range.startRow,
				startColumn: source.range.startCol,
				endRow: source.range.endRow,
				endColumn: source.range.endCol,
			})
			const style = srcRange.getCellStyle?.() ?? srcRange.getStyle?.()
			if (!style) throw new Error('[univer] format brush not supported')

			const tgtRange = targetSheet.getRange({
				startRow: target.range.startRow,
				startColumn: target.range.startCol,
				endRow: target.range.endRow,
				endColumn: target.range.endCol,
			})
			ctx.checkCanChange()
			const res = tgtRange.setStyle?.(style) ?? tgtRange.setCellStyle?.(style)
			if (res === undefined) throw new Error('[univer] format brush not supported')
			ctx.bumpChange()
			return { ok: true }
		},
	}

	return [set_range_style, format_brush]
}
