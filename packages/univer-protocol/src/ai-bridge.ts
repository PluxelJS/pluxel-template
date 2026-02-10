import type { UniverAiOpsV1, UniverAiRange } from './ai'

/**
 * Minimal Univer -> AI "call port" contract.
 *
 * This is intentionally tiny and stable: it defines the tool-call surface that
 * an agent can use to inspect/read/write a workbook via Univer APIs.
 *
 * Higher-level planning (single-turn JSON ChangeSet, loopback, etc.) can be built
 * on top of these primitives later.
 */

export type UniverAiToolName =
	| 'univer.listSheets'
	| 'univer.readRangeDisplay'
	| 'univer.applyOpsV1'
	| 'univer.clearRange'

export type UniverAiToolSpec = Readonly<{
	name: UniverAiToolName
	description: string
}>

export type UniverAiToolResult<T> = Readonly<{ ok: true; value: T } | { ok: false; error: string }>

export type UniverAiListSheetsResult = Readonly<{
	sheets: ReadonlyArray<{ sheetId: string; name: string }>
}>

export type UniverAiReadRangeDisplayInput = Readonly<{
	/**
	 * Prefer `sheetId` when known. When omitted, `a1` may include `SheetName!A1:B2`.
	 * If still missing, the runtime should default to the active sheet.
	 */
	sheetId?: string
	a1: string
	limits?: { maxRows?: number; maxCols?: number }
}>

export type UniverAiReadRangeDisplayResult = Readonly<{
	sheetId: string
	a1: string
	range: UniverAiRange
	values: string[][]
	truncated?: boolean
}>

export type UniverAiApplyOpsV1Input = Readonly<{
	sheetId: string
	ops: ReadonlyArray<UniverAiOpsV1>
}>

export type UniverAiApplyOpsV1Result = Readonly<{
	appliedOps: number
}>

export type UniverAiClearRangeInput = Readonly<{
	sheetId: string
	range: UniverAiRange
}>

export type UniverAiClearRangeResult = Readonly<{
	cleared: true
}>

export type UniverAiToolCall =
	| Readonly<{ tool: 'univer.listSheets'; args: Record<string, never> }>
	| Readonly<{ tool: 'univer.readRangeDisplay'; args: UniverAiReadRangeDisplayInput }>
	| Readonly<{ tool: 'univer.applyOpsV1'; args: UniverAiApplyOpsV1Input }>
	| Readonly<{ tool: 'univer.clearRange'; args: UniverAiClearRangeInput }>

