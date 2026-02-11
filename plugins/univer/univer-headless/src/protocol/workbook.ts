import type { SheetId, WorkbookId } from './primitives'

export type UniverWorkbookSheetInfo = Readonly<{
	sheetId: SheetId
	name: string
	index: number
	rowCount?: number
	colCount?: number
}>

export type UniverWorkbookInspection = Readonly<{
	schema: 1
	workbookId: WorkbookId
	activeSheetId: SheetId | null
	sheets: readonly UniverWorkbookSheetInfo[]
}>
