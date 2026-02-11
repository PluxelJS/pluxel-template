import type { A1Notation, SheetId, UniverRange, UniverRangeRef } from './primitives'

export type UniverToolName =
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

export type UniverToolGroup = 'core' | 'data' | 'sheet' | 'structure' | 'style'

export type UniverToolPreset = 'core' | 'data' | 'sheet' | 'structure' | 'style' | 'all'

export type UniverToolIndexMode = 'none' | 'groups' | 'tools'

export type UniverToolPolicy = Readonly<{
	goal?: string
	preset?: UniverToolPreset
	prefer?: readonly UniverToolGroup[]
	allow?: readonly UniverToolGroup[]
	exclude?: readonly UniverToolGroup[]
	maxGroups?: number
	includeLegacy?: boolean
	toolIndex?: UniverToolIndexMode
}>

export type UniverToolSpec = Readonly<{
	name: UniverToolName
	description: string
}>

export type UniverToolRangeInput = UniverRangeRef

export type UniverToolSetRangeDataInput = Readonly<
	UniverToolRangeInput & {
		values: unknown[][]
	}
>

export type UniverToolSetRangeDataResult = Readonly<{
	updatedCells: number
}>

export type UniverToolGetRangeDataInput = Readonly<
	UniverToolRangeInput & {
		includeDisplay?: boolean
	}
>

export type UniverToolGetRangeDataResult = Readonly<{
	sheetId: SheetId
	a1?: A1Notation
	range: UniverRange
	values: unknown[][]
	displayValues?: string[][]
}>

export type UniverToolSearchCellsInput = Readonly<
	UniverToolRangeInput & {
		query: string
		match?: 'contains' | 'exact' | 'regex'
		caseSensitive?: boolean
		maxResults?: number
	}
>

export type UniverToolSearchCellsResult = Readonly<{
	matches: ReadonlyArray<{ sheetId: SheetId; row: number; col: number; value: string }>
}>

export type UniverToolAutoFillInput = Readonly<{
	source: UniverToolRangeInput
	target: UniverToolRangeInput
}>

export type UniverToolAutoFillResult = Readonly<{
	updatedCells: number
}>

export type UniverToolFormatBrushInput = Readonly<{
	source: UniverToolRangeInput
	target: UniverToolRangeInput
}>

export type UniverToolFormatBrushResult = Readonly<{
	ok: true
}>

export type UniverToolSetRangeStyleInput = Readonly<
	UniverToolRangeInput & {
		style: Record<string, unknown>
	}
>

export type UniverToolSetRangeStyleResult = Readonly<{
	ok: true
}>

export type UniverToolCreateSheetInput = Readonly<{
	name?: string
	index?: number
}>

export type UniverToolCreateSheetResult = Readonly<{
	sheetId: SheetId
	name: string
}>

export type UniverToolDeleteSheetInput = Readonly<{
	sheetId?: SheetId
	name?: string
}>

export type UniverToolDeleteSheetResult = Readonly<{
	ok: true
}>

export type UniverToolRenameSheetInput = Readonly<{
	sheetId?: SheetId
	name?: string
	newName: string
}>

export type UniverToolRenameSheetResult = Readonly<{
	sheetId: SheetId
	name: string
}>

export type UniverToolActivateSheetInput = Readonly<{
	sheetId?: SheetId
	name?: string
}>

export type UniverToolActivateSheetResult = Readonly<{
	ok: true
	activeSheetId: SheetId
}>

export type UniverToolMoveSheetInput = Readonly<{
	sheetId?: SheetId
	name?: string
	index: number
}>

export type UniverToolMoveSheetResult = Readonly<{
	ok: true
}>

export type UniverToolSetSheetDisplayStatusInput = Readonly<{
	sheetId?: SheetId
	name?: string
	hidden: boolean
}>

export type UniverToolSetSheetDisplayStatusResult = Readonly<{
	ok: true
}>

export type UniverToolInsertRowsInput = Readonly<{
	sheetId?: SheetId
	name?: string
	index: number
	count: number
}>

export type UniverToolInsertRowsResult = Readonly<{
	ok: true
}>

export type UniverToolInsertColumnsInput = Readonly<{
	sheetId?: SheetId
	name?: string
	index: number
	count: number
}>

export type UniverToolInsertColumnsResult = Readonly<{
	ok: true
}>

export type UniverToolDeleteRowsInput = Readonly<{
	sheetId?: SheetId
	name?: string
	index: number
	count: number
}>

export type UniverToolDeleteRowsResult = Readonly<{
	ok: true
}>

export type UniverToolDeleteColumnsInput = Readonly<{
	sheetId?: SheetId
	name?: string
	index: number
	count: number
}>

export type UniverToolDeleteColumnsResult = Readonly<{
	ok: true
}>

export type UniverToolSetCellDimensionsInput = Readonly<{
	sheetId?: SheetId
	name?: string
	rows?: Readonly<{
		startRow: number
		endRow: number
		height: number
	}>
	cols?: Readonly<{
		startCol: number
		endCol: number
		width: number
	}>
}>

export type UniverToolSetCellDimensionsResult = Readonly<{
	ok: true
}>

export type UniverToolSetMergeInput = Readonly<{
	sheetId?: SheetId
	name?: string
	range: UniverRange
	merge?: boolean
}>

export type UniverToolSetMergeResult = Readonly<{
	ok: true
}>

export type UniverToolSheetInfo = Readonly<{
	sheetId: SheetId
	name: string
	index?: number
	hidden?: boolean
}>

export type UniverToolGetSheetsResult = Readonly<{
	sheets: readonly UniverToolSheetInfo[]
}>

export type UniverToolGetActiveUnitIdResult = Readonly<{
	workbookId: string | null
	activeSheetId: SheetId | null
}>

export type UniverToolGetActivityStatusResult = Readonly<{
	workbookId: string | null
	activeSheetId: SheetId | null
	sheetCount: number
}>
