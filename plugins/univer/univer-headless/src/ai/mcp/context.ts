import type { UniverAiRange } from '../../protocol'
import type { UniverAiBridge } from '../bridge'

export type McpStats = {
	toolCalls: number
	appliedOps: number
	appliedClears: number
	readCalls: number
}

export type A1Scope = {
	a1: string
	sheetName?: string
	range: UniverAiRange
	sheetId?: string
}

export type McpLimits = {
	maxOps: number
	maxChanges: number
}

export type McpLogger = { warn?: (...args: any[]) => void }

export type McpContext = {
	bridge: UniverAiBridge
	workbook: any
	readScopes: A1Scope[]
	writeScopes: A1Scope[]
	sheetIdToName: Map<string, string>
	sheetNameToId: Map<string, string>
	limits: McpLimits
	stats: McpStats
	logger?: McpLogger
	bumpChange(): void
	checkReadRange(range: UniverAiRange, sheetId?: string, sheetName?: string): void
	checkWriteRange(range: UniverAiRange, sheetId?: string, sheetName?: string): void
	checkWriteCell(row: number, col: number, sheetId?: string, sheetName?: string): void
	checkWriteSheet(sheetId?: string, sheetName?: string): void
}
