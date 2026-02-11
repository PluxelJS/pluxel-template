import type { UniverRange } from '../../protocol'
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
	range: UniverRange
	sheetId?: string
}

export type McpLimits = {
	maxOps: number
	maxChanges: number
}

export type McpLogger = {
	debug?: (message: string, props?: Record<string, unknown>) => void
	info?: (message: string, props?: Record<string, unknown>) => void
	warn?: (message: string, props?: Record<string, unknown>) => void
}

export type McpCache = {
	epoch: number
	get(key: string): unknown | undefined
	set(key: string, value: unknown): void
	clear(): void
}

export type McpContext = {
	bridge: UniverAiBridge
	workbook: any
	readScopes: A1Scope[]
	writeScopes: A1Scope[]
	sheetIdToName: Map<string, string>
	sheetNameToId: Map<string, string>
	/** Default sheet used when tool inputs omit sheetId/sheetName. */
	defaultSheetId?: string
	/** Default sheet used when tool inputs omit sheetId/sheetName. */
	defaultSheetName?: string
	/** Preferred read clip limits for returning tool outputs. */
	viewLimits?: Readonly<{ maxRows: number; maxCols: number }>
	limits: McpLimits
	stats: McpStats
	logger?: McpLogger
	cache?: McpCache
	/** Validate change budget (does not mutate state). */
	checkCanChange(): void
	/** Validate ops budget (does not mutate state). */
	checkCanApplyOps(ops: number): void
	/** Commit a workbook change (increments budget + bumps write epoch). */
	bumpChange(): void
	checkReadRange(range: UniverRange, sheetId?: string, sheetName?: string): void
	checkWriteRange(range: UniverRange, sheetId?: string, sheetName?: string): void
	checkWriteCell(row: number, col: number, sheetId?: string, sheetName?: string): void
	checkWriteSheet(sheetId?: string, sheetName?: string): void
}
