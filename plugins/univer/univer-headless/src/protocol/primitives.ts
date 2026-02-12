export type WorkbookId = string
export type SheetId = string
export type A1Notation = string

export type UniverRange = Readonly<{
	startRow: number
	startCol: number
	endRow: number
	endCol: number
}>

export type UniverRangeRef = Readonly<
	| {
			sheetId?: SheetId
			sheetName?: string
			a1: A1Notation
			range?: never
	  }
	| {
			sheetId?: SheetId
			sheetName?: string
			range: UniverRange
			a1?: never
	  }
>
