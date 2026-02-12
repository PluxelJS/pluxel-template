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

const RangeInputSchema = Type.Union([
	Type.Object(
		{
			...RangeInputBaseProps,
			a1: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...RangeInputBaseProps,
			range: RangeSchema,
		},
		{ additionalProperties: false },
	),
])

const SetRangeStyleSchema = Type.Union([
	Type.Object(
		{
			...RangeInputBaseProps,
			a1: Type.String(),
			style: Type.Object({}, { additionalProperties: true }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...RangeInputBaseProps,
			range: RangeSchema,
			style: Type.Object({}, { additionalProperties: true }),
		},
		{ additionalProperties: false },
	),
])

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
		parameters: asAxParams(SetRangeStyleSchema),
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
