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

const SetRangeStyleSchema = Type.Object(
	{
		...RangeInputProps,
		style: Type.Object({}, { additionalProperties: true }),
	},
	{ additionalProperties: false },
)

const FormatBrushSchema = Type.Object(
	{
		source: RangeInputSchema,
		target: RangeInputSchema,
	},
	{ additionalProperties: false },
)

export function createStyleTools(ctx: McpContext): AxFunction[] {
	const set_range_style: AxFunction = {
		name: 'set_range_style',
		description: getMcpToolDescription('set_range_style'),
		parameters: SetRangeStyleSchema as any,
		func: async (input: UniverToolSetRangeStyleInput): Promise<UniverToolSetRangeStyleResult> => {
			ctx.stats.toolCalls++

			const { range, sheetName } = resolveRangeInput(input)
			ctx.checkWriteRange(range, input.sheetId, sheetName ?? input.sheetName)

			const sheet = resolveSheet(
				ctx.workbook,
				input.sheetId ?? ctx.defaultSheetId,
				sheetName ?? input.sheetName ?? ctx.defaultSheetName,
			)
			const r = sheet.getRange({
				startRow: range.startRow,
				startColumn: range.startCol,
				endRow: range.endRow,
				endColumn: range.endCol,
			})
			ctx.checkCanChange()
			const res = r.setStyle?.(input.style as any) ?? r.setCellStyle?.(input.style as any)
			if (res === undefined) throw new Error('[univer] set style not supported')
			ctx.bumpChange()
			return { ok: true }
		},
	}

	const format_brush: AxFunction = {
		name: 'format_brush',
		description: getMcpToolDescription('format_brush'),
		parameters: FormatBrushSchema as any,
		func: async (input: UniverToolFormatBrushInput): Promise<UniverToolFormatBrushResult> => {
			ctx.stats.toolCalls++

			const source = resolveRangeInput(input.source)
			const target = resolveRangeInput(input.target)
			const effSheetId = input.target.sheetId ?? input.source.sheetId ?? ctx.defaultSheetId
			const effSheetName =
				target.sheetName ?? input.target.sheetName ?? source.sheetName ?? input.source.sheetName ?? ctx.defaultSheetName
			ctx.checkReadRange(source.range, input.source.sheetId ?? effSheetId, source.sheetName ?? input.source.sheetName ?? effSheetName)
			ctx.checkWriteRange(target.range, input.target.sheetId ?? effSheetId, target.sheetName ?? input.target.sheetName ?? effSheetName)

			const sheet = resolveSheet(ctx.workbook, effSheetId, effSheetName)

			const srcRange = sheet.getRange({
				startRow: source.range.startRow,
				startColumn: source.range.startCol,
				endRow: source.range.endRow,
				endColumn: source.range.endCol,
			})
			const style = srcRange.getCellStyle?.() ?? srcRange.getStyle?.()
			if (!style) throw new Error('[univer] format brush not supported')

			const tgtRange = sheet.getRange({
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
