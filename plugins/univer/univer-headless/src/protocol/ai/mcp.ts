import type { UniverAiRange } from './types'

export type UniverMcpToolName =
	| 'set_range_data'
	| 'get_range_data'
	| 'search_cells'
	| 'auto_fill'
	| 'format_brush'
	| 'set_range_style'
	| 'create_sheet'
	| 'delete_sheet'
	| 'rename_sheet'
	| 'activate_sheet'
	| 'move_sheet'
	| 'set_sheet_display_status'
	| 'get_sheets'
	| 'get_active_unit_id'
	| 'insert_rows'
	| 'insert_columns'
	| 'delete_rows'
	| 'delete_columns'
	| 'set_cell_dimensions'
	| 'set_merge'
	| 'get_activity_status'

export type UniverMcpToolSpec = Readonly<{
	name: UniverMcpToolName
	description: string
}>

export type UniverMcpSheetInfo = Readonly<{
	sheetId: string
	name: string
	index?: number
	hidden?: boolean
}>

export type UniverMcpGetSheetsResult = Readonly<{
	sheets: readonly UniverMcpSheetInfo[]
}>

export type UniverMcpGetActiveUnitIdResult = Readonly<{
	workbookId: string | null
	activeSheetId: string | null
}>

export type UniverMcpGetActivityStatusResult = Readonly<{
	workbookId: string | null
	activeSheetId: string | null
	sheetCount: number
}>

export type UniverMcpRangeInput = Readonly<{
	sheetId?: string
	sheetName?: string
	a1?: string
	range?: UniverAiRange
}>

export type UniverMcpSetRangeDataInput = Readonly<
	UniverMcpRangeInput & {
		values: unknown[][]
	}
>

export type UniverMcpSetRangeDataResult = Readonly<{
	updatedCells: number
}>

export type UniverMcpGetRangeDataInput = Readonly<
	UniverMcpRangeInput & {
		includeDisplay?: boolean
	}
>

export type UniverMcpGetRangeDataResult = Readonly<{
	sheetId: string
	a1?: string
	range: UniverAiRange
	values: unknown[][]
	displayValues?: string[][]
}>

export type UniverMcpSearchCellsInput = Readonly<
	UniverMcpRangeInput & {
		query: string
		match?: 'contains' | 'exact' | 'regex'
		caseSensitive?: boolean
		maxResults?: number
	}
>

export type UniverMcpSearchCellsResult = Readonly<{
	matches: ReadonlyArray<{ sheetId: string; row: number; col: number; value: string }>
}>

export type UniverMcpAutoFillInput = Readonly<{
	source: UniverMcpRangeInput
	target: UniverMcpRangeInput
}>

export type UniverMcpAutoFillResult = Readonly<{
	updatedCells: number
}>

export type UniverMcpFormatBrushInput = Readonly<{
	source: UniverMcpRangeInput
	target: UniverMcpRangeInput
}>

export type UniverMcpFormatBrushResult = Readonly<{
	ok: true
}>

export type UniverMcpSetRangeStyleInput = Readonly<
	UniverMcpRangeInput & {
		style: Record<string, unknown>
	}
>

export type UniverMcpSetRangeStyleResult = Readonly<{
	ok: true
}>

export type UniverMcpCreateSheetInput = Readonly<{
	name?: string
	index?: number
}>

export type UniverMcpCreateSheetResult = Readonly<{
	sheetId: string
	name: string
}>

export type UniverMcpDeleteSheetInput = Readonly<{
	sheetId?: string
	name?: string
}>

export type UniverMcpDeleteSheetResult = Readonly<{
	ok: true
}>

export type UniverMcpRenameSheetInput = Readonly<{
	sheetId?: string
	name?: string
	newName: string
}>

export type UniverMcpRenameSheetResult = Readonly<{
	sheetId: string
	name: string
}>

export type UniverMcpActivateSheetInput = Readonly<{
	sheetId?: string
	name?: string
}>

export type UniverMcpActivateSheetResult = Readonly<{
	ok: true
	activeSheetId: string
}>

export type UniverMcpMoveSheetInput = Readonly<{
	sheetId?: string
	name?: string
	index: number
}>

export type UniverMcpMoveSheetResult = Readonly<{
	ok: true
}>

export type UniverMcpSetSheetDisplayStatusInput = Readonly<{
	sheetId?: string
	name?: string
	hidden: boolean
}>

export type UniverMcpSetSheetDisplayStatusResult = Readonly<{
	ok: true
}>

export type UniverMcpInsertRowsInput = Readonly<{
	sheetId?: string
	name?: string
	index: number
	count: number
}>

export type UniverMcpInsertRowsResult = Readonly<{
	ok: true
}>

export type UniverMcpInsertColumnsInput = Readonly<{
	sheetId?: string
	name?: string
	index: number
	count: number
}>

export type UniverMcpInsertColumnsResult = Readonly<{
	ok: true
}>

export type UniverMcpDeleteRowsInput = Readonly<{
	sheetId?: string
	name?: string
	index: number
	count: number
}>

export type UniverMcpDeleteRowsResult = Readonly<{
	ok: true
}>

export type UniverMcpDeleteColumnsInput = Readonly<{
	sheetId?: string
	name?: string
	index: number
	count: number
}>

export type UniverMcpDeleteColumnsResult = Readonly<{
	ok: true
}>

export type UniverMcpSetCellDimensionsInput = Readonly<{
	sheetId?: string
	name?: string
	rows?: { startRow: number; endRow: number; height: number }
	cols?: { startCol: number; endCol: number; width: number }
}>

export type UniverMcpSetCellDimensionsResult = Readonly<{
	ok: true
}>

export type UniverMcpSetMergeInput = Readonly<{
	sheetId?: string
	name?: string
	range: UniverAiRange
	merge?: boolean
}>

export type UniverMcpSetMergeResult = Readonly<{
	ok: true
}>
