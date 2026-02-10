import type { AxFunction } from '@ax-llm/ax'
import { Type } from '@sinclair/typebox'
import type {
	UniverMcpFormatBrushInput,
	UniverMcpFormatBrushResult,
	UniverMcpSetRangeStyleInput,
	UniverMcpSetRangeStyleResult,
} from '../../protocol'

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
		description: 'Apply cell styling to a range.',
		parameters: SetRangeStyleSchema,
		func: async (input: UniverMcpSetRangeStyleInput): Promise<UniverMcpSetRangeStyleResult> => {
			ctx.stats.toolCalls++
			ctx.bumpChange()

			const { range, sheetName } = resolveRangeInput(input)
			ctx.checkWriteRange(range, input.sheetId, sheetName ?? input.sheetName)

			const sheet = resolveSheet(ctx.workbook, input.sheetId, sheetName ?? input.sheetName)
			const r = sheet.getRange({
				startRow: range.startRow,
				startColumn: range.startCol,
				endRow: range.endRow,
				endColumn: range.endCol,
			})
			const res = r.setStyle?.(input.style as any) ?? r.setCellStyle?.(input.style as any)
			if (res === undefined) throw new Error('[univer] set style not supported')
			return { ok: true }
		},
	}

	const format_brush: AxFunction = {
		name: 'format_brush',
		description: 'Copy and apply cell formatting from source to target.',
		parameters: FormatBrushSchema,
		func: async (input: UniverMcpFormatBrushInput): Promise<UniverMcpFormatBrushResult> => {
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
			const res = tgtRange.setStyle?.(style) ?? tgtRange.setCellStyle?.(style)
			if (res === undefined) throw new Error('[univer] format brush not supported')
			return { ok: true }
		},
	}

	return [set_range_style, format_brush]
}
