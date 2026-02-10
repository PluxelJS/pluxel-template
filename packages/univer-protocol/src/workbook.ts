export type UniverWorkbookSheetInfo = Readonly<{
	sheetId: string
	name: string
	/** 0-based order in workbook.getSheets(). */
	index: number
	rowCount?: number
	colCount?: number
}>

export type UniverWorkbookInspection = Readonly<{
	schema: 1
	workbookId: string
	activeSheetId: string | null
	sheets: readonly UniverWorkbookSheetInfo[]
}>

