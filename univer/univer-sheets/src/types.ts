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
