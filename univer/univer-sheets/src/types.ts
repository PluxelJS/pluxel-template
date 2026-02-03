import type { CellValue, ICellData, IObjectMatrixPrimitiveType } from '@univerjs/core'

export type TextWatermarkSettings = {
	content: string
	fontSize?: number
	color?: string
	repeat?: boolean
	rotate?: number
	opacity?: number
}

export type UniverTextWatermarkContribution = {
	type: 'watermark:text'
	id: string
	priority?: number
	settings: TextWatermarkSettings
}

export type UniverContribution = UniverTextWatermarkContribution

export type UniverContributionInput = Omit<UniverContribution, 'id'>

export type SheetsPatchAction =
	| {
			op: 'set'
			sheetName?: string
			range: string
			value: CellValue | ICellData
	  }
	| {
			op: 'setValues'
			sheetName?: string
			range: string
			values:
				| CellValue[][]
				| IObjectMatrixPrimitiveType<CellValue>
				| ICellData[][]
				| IObjectMatrixPrimitiveType<ICellData>
	  }
	| { op: 'clear'; sheetName?: string; range: string }

export type SheetsPatchSpec = {
	actions: SheetsPatchAction[]
}
