import type { A1Notation, SheetId, UniverRange, UniverRangeRef } from './primitives'

export type UniverToolName =
	| 'set_range_data'
	| 'set_ranges_data'
	| 'get_range_data'
	| 'get_ranges_data'
	| 'search_cells'
	| 'auto_fill'
	| 'fill_formula'
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

export type UniverToolSpec = Readonly<{
	name: UniverToolName
	description: string
}>

export type UniverToolRangeInput = UniverRangeRef

export type UniverToolSetRangeDataInput = Readonly<
	UniverToolRangeInput & {
		values: unknown[][]
		/**
		 * Optional write-time verification readback (performed after the write).
		 * Note: readback is still subject to readScopes.
		 */
		readback?: Readonly<{ includeDisplay?: boolean }>
	}
>

export type UniverToolSetRangeDataResult = Readonly<{
	updatedCells: number
	/**
	 * Optional non-fatal normalization warning, e.g. when the tool had to shrink the written range
	 * due to an undersized matrix.
	 */
	warning?: string
	readback?: UniverToolGetRangesDataResult
}>

export type UniverToolSetRangesDataInput = Readonly<{
	updates: ReadonlyArray<UniverToolSetRangeDataInput>
	/**
	 * Optional write-time verification readback (performed after the write).
	 * - If ranges is omitted/empty, defaults to reading back the updated ranges.
	 * - Still subject to readScopes.
	 */
	readback?: Readonly<{ includeDisplay?: boolean; ranges?: ReadonlyArray<UniverToolGetRangeDataInput> }>
}>

export type UniverToolSetRangesDataResult = Readonly<{
	updates: number
	updatedCells: number
	/** Optional per-update normalization warnings. */
	warnings?: ReadonlyArray<string>
	readback?: UniverToolGetRangesDataResult
}>

export type UniverToolGetRangeDataInput = Readonly<
	UniverToolRangeInput & {
		includeDisplay?: boolean
	}
>

export type UniverToolGetRangeDataResult = Readonly<{
	sheetId: SheetId
	sheetName?: string
	/** Returned A1 (matches `range`/`values` payload; may be clipped). */
	a1: A1Notation
	/** Requested A1 (when the original request was larger than the returned clipped range). */
	requestedA1?: A1Notation
	range: UniverRange
	values: unknown[][]
	displayValues?: string[][]
	truncated?: boolean
	origRange?: UniverRange
}>

export type UniverToolGetRangesDataInput = Readonly<{
	ranges: ReadonlyArray<UniverToolGetRangeDataInput>
	includeDisplay?: boolean
}>

export type UniverToolGetRangesDataResult = Readonly<{
	/** Requested A1 keys, in a stable order (deduped). Prefer this over iterating object keys. */
	order: ReadonlyArray<A1Notation>
	/** Canonical payload, keyed by requested A1 (or the derived requested A1 when caller omitted a1). */
	byA1: Record<string, UniverToolGetRangeDataResult>
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
	matches: ReadonlyArray<{ sheetId: SheetId; sheetName?: string; a1: A1Notation; row: number; col: number; value: string }>
}>

export type UniverToolAutoFillInput = Readonly<{
	source: UniverToolRangeInput
	target: UniverToolRangeInput
	/**
	 * Optional write-time verification readback (performed after the write).
	 * Defaults to reading back the target range.
	 */
	readback?: Readonly<{ includeDisplay?: boolean }>
}>

export type UniverToolAutoFillResult = Readonly<{
	updatedCells: number
	readback?: UniverToolGetRangesDataResult
}>

export type UniverToolFillFormulaInput = Readonly<
	UniverToolRangeInput & {
		/** A1 formula string. Must start with '='. Relative refs will be shifted per-cell. */
		formula: string
		/**
		 * Optional write-time verification readback (performed after the write).
		 * Defaults to reading back the target range.
		 */
		readback?: Readonly<{ includeDisplay?: boolean }>
	}
>

export type UniverToolFillFormulaResult = Readonly<{
	updatedCells: number
	readback?: UniverToolGetRangesDataResult
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
