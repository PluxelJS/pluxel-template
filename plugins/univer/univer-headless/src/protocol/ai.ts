import type { A1Notation, SheetId, UniverRange, WorkbookId } from './primitives'

export const UNIVER_AI_SSE_NS = 'univer:ai' as const

export const UNIVER_AI_DEFAULT_CONTRACT_LIMITS = {
	maxChanges: 24,
	maxOps: 4000,
} as const

export type UniverAiContractLimits = Readonly<{
	maxChanges?: number
	maxOps?: number
}>

export type UniverAiProfile = Readonly<{
	id: string
	provider: string
	model?: string
	baseURL?: string
}>

export type UniverAiCapability = Readonly<{
	available: boolean
	defaultProfile?: UniverAiProfile
	reason?: string
}>

export type UniverSelection = Readonly<{
	sheetId?: SheetId
	a1?: A1Notation
	range: UniverRange
	display?: string[][]
	values?: unknown[][]
	truncated?: boolean
	orig?: Readonly<{
		startRow: number
		startCol: number
		endRow: number
		endCol: number
		rows: number
		cols: number
	}>
	limits?: Readonly<{ maxRows: number; maxCols: number }>
}>

export type UniverAiContext = Readonly<{
	workbookId: WorkbookId
	selection: UniverSelection
	meta?: Record<string, unknown>
}>

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
	sheets: ReadonlyArray<{ sheetId: SheetId; name: string }>
}>

export type UniverAiReadRangeDisplayInput = Readonly<{
	sheetId?: SheetId
	a1: A1Notation
	limits?: { maxRows?: number; maxCols?: number }
}>

export type UniverAiReadRangeDisplayResult = Readonly<{
	sheetId: SheetId
	a1: A1Notation
	range: UniverRange
	values: string[][]
	truncated?: boolean
}>

export type UniverAiOpsV1 =
	| Readonly<{ op: 'set'; row: number; col: number; value: string }>
	| Readonly<{ op: 'clear'; row: number; col: number }>

export type UniverAiApplyOpsV1Input = Readonly<{
	sheetId: SheetId
	ops: ReadonlyArray<UniverAiOpsV1>
}>

export type UniverAiApplyOpsV1Result = Readonly<{
	appliedOps: number
}>

export type UniverAiClearRangeInput = Readonly<{
	sheetId: SheetId
	range: UniverRange
}>

export type UniverAiClearRangeResult = Readonly<{
	cleared: true
}>

export type UniverAiToolCall =
	| Readonly<{ tool: 'univer.listSheets'; args: Record<string, never> }>
	| Readonly<{ tool: 'univer.readRangeDisplay'; args: UniverAiReadRangeDisplayInput }>
	| Readonly<{ tool: 'univer.applyOpsV1'; args: UniverAiApplyOpsV1Input }>
	| Readonly<{ tool: 'univer.clearRange'; args: UniverAiClearRangeInput }>

export type UniverAiThreadEvent =
	| Readonly<{
			type: 'request'
			at: number
			requestId?: string
			instruction: string
			contextHint?: { sheetId?: SheetId; a1?: A1Notation }
	  }>
	| Readonly<{
			type: 'status'
			at: number
			requestId?: string
			stage: string
			message?: string
	  }>
	| Readonly<{
			type: 'result'
			at: number
			requestId?: string
			changes: number
			ops: number
			summary?: string
	  }>
	| Readonly<{
			type: 'error'
			at: number
			requestId?: string
			error: string
	  }>

export type UniverAiThreadEventEnvelope = Readonly<{
	schema: 1
	threadId: string
	offset: number
	event: UniverAiThreadEvent
}>

export type UniverAiThreadSnapshot = Readonly<{
	schema: 1
	threadId: string
	baseOffset: number
	nextOffset: number
	events: ReadonlyArray<UniverAiThreadEventEnvelope>
}>
