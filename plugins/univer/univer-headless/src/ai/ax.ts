import { ax, type AxAI, type AxFunction } from '@ax-llm/ax'
import { Type } from '@sinclair/typebox'
import { UNIVER_AI_DEFAULT_CONTRACT_LIMITS } from '../protocol'
import type {
	UniverAiApplyOpsV1Input,
	UniverAiApplyOpsV1Result,
	UniverAiClearRangeInput,
	UniverAiClearRangeResult,
	UniverAiListSheetsResult,
	UniverAiOpsV1,
	UniverAiRange,
	UniverAiReadRangeDisplayInput,
	UniverAiReadRangeDisplayResult,
} from '../protocol'

import type { UniverAiBridge } from './bridge'
import { parseA1Range } from './a1'
import { createMcpTools, listMcpToolNames, type McpToolGroup } from './mcp'
import type { A1Scope, McpContext, McpLogger, McpStats } from './mcp/context'

type Logger = McpLogger

export type UniverAxLoopbackInput = Readonly<{
	instruction: string
	read: readonly string[]
	write?: readonly string[]
	current?: string
	mode?: 'safe' | 'aggressive'
	limits?: { maxRows?: number; maxCols?: number }
	contractLimits?: { maxOps?: number; maxChanges?: number }
	toolPolicy?: UniverAxToolPolicy
}>

export type UniverAxLoopbackStats = Readonly<McpStats>

export type UniverAxLoopbackResult = Readonly<
	| { ok: true; summary: string; stats: UniverAxLoopbackStats }
	| { ok: false; error: string; stats: UniverAxLoopbackStats }
>

type AxToolsResult = Readonly<{ tools: AxFunction[]; stats: UniverAxLoopbackStats }>

export type UniverAxToolPolicy = Readonly<{
	goal?: string
	prefer?: readonly McpToolGroup[]
	allow?: readonly McpToolGroup[]
	exclude?: readonly McpToolGroup[]
	maxGroups?: number
	includeLegacy?: boolean
}>

function normalizeA1List(list: readonly string[] | undefined): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	for (const raw of list ?? []) {
		const a1 = String(raw ?? '').trim()
		if (!a1 || seen.has(a1)) continue
		seen.add(a1)
		out.push(a1)
	}
	return out
}

function toScopes(list: readonly string[]): A1Scope[] {
	return list.map((a1) => {
		const parsed = parseA1Range(a1)
		return { a1: parsed.a1, sheetName: parsed.sheetName, range: parsed.range }
	})
}

function rangeContainsCell(range: UniverAiRange, row: number, col: number) {
	return row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol
}

function rangeWithin(a: UniverAiRange, b: UniverAiRange) {
	return a.startRow >= b.startRow && a.endRow <= b.endRow && a.startCol >= b.startCol && a.endCol <= b.endCol
}

function scopeListForSheet(scopes: A1Scope[], sheetId?: string, sheetName?: string): A1Scope[] {
	if (sheetId) {
		const byId = scopes.filter((s) => s.sheetId && s.sheetId === sheetId)
		if (byId.length) return byId
	}
	if (sheetName) {
		const byName = scopes.filter((s) => s.sheetName && s.sheetName === sheetName)
		if (byName.length) return byName
	}
	return scopes.filter((s) => !s.sheetName)
}

function clampInt(n: unknown, min: number, max: number) {
	const v = typeof n === 'number' && Number.isFinite(n) ? n : min
	return Math.max(min, Math.min(max, Math.floor(v)))
}

function resolveContractLimits(input?: { maxOps?: number; maxChanges?: number }) {
	const maxOps =
		typeof input?.maxOps === 'number' && Number.isFinite(input.maxOps)
			? clampInt(input.maxOps, 1, 50_000)
			: UNIVER_AI_DEFAULT_CONTRACT_LIMITS.maxOps
	const maxChanges =
		typeof input?.maxChanges === 'number' && Number.isFinite(input.maxChanges)
			? clampInt(input.maxChanges, 1, 200)
			: UNIVER_AI_DEFAULT_CONTRACT_LIMITS.maxChanges
	return { maxOps, maxChanges }
}

function buildSheetMaps(bridge: UniverAiBridge) {
	const sheetIdToName = new Map<string, string>()
	const sheetNameToId = new Map<string, string>()
	try {
		const res = bridge.listSheets()
		for (const s of res.sheets ?? []) {
			if (!s.sheetId || !s.name) continue
			sheetIdToName.set(String(s.sheetId), String(s.name))
			sheetNameToId.set(String(s.name), String(s.sheetId))
		}
	} catch {
		// best-effort only
	}
	return { sheetIdToName, sheetNameToId }
}

function attachSheetIds(scopes: A1Scope[], sheetNameToId: Map<string, string>) {
	for (const s of scopes) {
		if (!s.sheetName) continue
		const sid = sheetNameToId.get(s.sheetName)
		if (sid) s.sheetId = sid
	}
}

const TOOL_GROUP_PRIORITY: ReadonlyArray<McpToolGroup> = ['core', 'data', 'sheet', 'structure', 'style']

const KEYWORDS: Record<McpToolGroup, ReadonlyArray<string>> = {
	core: ['read', 'write', 'search', 'lookup', 'find', 'get', 'set', '查询', '搜索', '读取', '写入'],
	data: ['fill', 'autofill', '填充', '填满', 'auto fill'],
	sheet: ['sheet', 'worksheet', 'tab', '工作表', '表单', '新建表', '重命名', '删除表', '隐藏', '显示', '切换'],
	structure: ['row', 'rows', 'column', 'columns', '行', '列', '插入', '删除行', '删除列', '合并', 'merge', '宽度', '高度'],
	style: ['format', 'style', 'color', 'font', 'bold', 'italic', 'underline', '对齐', '边框', '颜色', '字体', '样式'],
}

function normalizeGroups(list?: readonly McpToolGroup[]): McpToolGroup[] {
	if (!list?.length) return []
	const out: McpToolGroup[] = []
	const seen = new Set<McpToolGroup>()
	for (const g of list) {
		if (seen.has(g)) continue
		seen.add(g)
		out.push(g)
	}
	return out
}

export function resolveUniverAxToolGroups(
	instruction: string,
	policy?: UniverAxToolPolicy,
): { groups: McpToolGroup[]; reason: string } {
	const text = `${instruction ?? ''} ${policy?.goal ?? ''}`.toLowerCase()
	const selected = new Set<McpToolGroup>(['core'])

	for (const g of TOOL_GROUP_PRIORITY) {
		const keywords = KEYWORDS[g]
		if (!keywords?.length) continue
		if (keywords.some((k) => text.includes(k))) selected.add(g)
	}

	for (const g of normalizeGroups(policy?.prefer)) selected.add(g)

	const allow = new Set(normalizeGroups(policy?.allow))
	if (allow.size) {
		for (const g of [...selected]) {
			if (!allow.has(g) && g !== 'core') selected.delete(g)
		}
	}

	for (const g of normalizeGroups(policy?.exclude)) selected.delete(g)

	let groups = TOOL_GROUP_PRIORITY.filter((g) => selected.has(g))
	const maxGroups =
		typeof policy?.maxGroups === 'number' && Number.isFinite(policy.maxGroups)
			? Math.max(1, Math.floor(policy.maxGroups))
			: groups.length
	if (groups.length > maxGroups) groups = groups.slice(0, maxGroups)

	if (!groups.includes('core')) groups = ['core', ...groups]

	const reason = policy?.goal ? `goal:${policy.goal}` : 'auto'
	return { groups, reason }
}

export function createUniverAxTools(
	bridge: UniverAiBridge,
	opts: {
		instruction?: string
		readScopes: readonly string[]
		writeScopes: readonly string[]
		limits?: { maxRows?: number; maxCols?: number }
		contractLimits?: { maxOps?: number; maxChanges?: number }
		toolPolicy?: UniverAxToolPolicy
		logger?: Logger
	},
): AxToolsResult {
	const readList = normalizeA1List(opts.readScopes)
	const writeList = normalizeA1List(opts.writeScopes)
	if (!readList.length) throw new Error('[univer] read scopes must be non-empty')
	if (!writeList.length) throw new Error('[univer] write scopes must be non-empty')

	const readScopes = toScopes(readList)
	const writeScopes = toScopes(writeList)

	const { sheetIdToName, sheetNameToId } = buildSheetMaps(bridge)
	attachSheetIds(readScopes, sheetNameToId)
	attachSheetIds(writeScopes, sheetNameToId)

	const limits = resolveContractLimits(opts.contractLimits)
	let changeCount = 0
	const stats: McpStats = {
		toolCalls: 0,
		appliedOps: 0,
		appliedClears: 0,
		readCalls: 0,
	}

	const listSheets = async (): Promise<UniverAiListSheetsResult> => {
		stats.toolCalls++
		return bridge.listSheets()
	}

	const readRangeDisplay = async (
		input: UniverAiReadRangeDisplayInput,
	): Promise<UniverAiReadRangeDisplayResult> => {
		stats.toolCalls++
		stats.readCalls++
		const a1 = String(input?.a1 ?? '').trim()
		if (!a1) throw new Error('[univer] a1 required')
		const parsed = parseA1Range(a1)
		const sheetName = parsed.sheetName ?? (input.sheetId ? sheetIdToName.get(input.sheetId) : undefined)
		const scopes = scopeListForSheet(readScopes, input.sheetId, sheetName)
		if (!scopes.length) throw new Error('[univer] read scope not allowed')
		const allowed = scopes.some((s) => rangeWithin(parsed.range, s.range))
		if (!allowed) throw new Error('[univer] read range out of scope')
		const next: UniverAiReadRangeDisplayInput = {
			...input,
			a1: parsed.a1,
			limits: input.limits ?? opts.limits,
		}
		return bridge.readRangeDisplay(next)
	}

	const applyOpsV1 = async (input: UniverAiApplyOpsV1Input): Promise<UniverAiApplyOpsV1Result> => {
		stats.toolCalls++
		const sheetId = String(input?.sheetId ?? '').trim()
		if (!sheetId) throw new Error('[univer] sheetId required')
		const ops = Array.isArray(input?.ops) ? (input.ops as UniverAiOpsV1[]) : []
		if (!ops.length) return { appliedOps: 0 }

		const sheetName = sheetIdToName.get(sheetId)
		const scopes = scopeListForSheet(writeScopes, sheetId, sheetName)
		if (!scopes.length) throw new Error('[univer] write scope not allowed')

		for (const op of ops) {
			const row = (op as any).row
			const col = (op as any).col
			if (!Number.isInteger(row) || !Number.isInteger(col)) throw new Error('[univer] op row/col must be integers')
			const allowed = scopes.some((s) => rangeContainsCell(s.range, row, col))
			if (!allowed) throw new Error('[univer] op out of write scope')
		}

		changeCount += 1
		if (changeCount > limits.maxChanges) throw new Error(`[univer] changes exceed limit: ${changeCount} > ${limits.maxChanges}`)
		const nextOps = stats.appliedOps + ops.length
		if (nextOps > limits.maxOps) throw new Error(`[univer] ops exceed limit: ${nextOps} > ${limits.maxOps}`)

		const res = bridge.applyOpsV1(input)
		stats.appliedOps += res.appliedOps
		return res
	}

	const clearRange = async (input: UniverAiClearRangeInput): Promise<UniverAiClearRangeResult> => {
		stats.toolCalls++
		const sheetId = String(input?.sheetId ?? '').trim()
		if (!sheetId) throw new Error('[univer] sheetId required')
		const range = input?.range as UniverAiRange
		if (!range) throw new Error('[univer] range required')

		const sheetName = sheetIdToName.get(sheetId)
		const scopes = scopeListForSheet(writeScopes, sheetId, sheetName)
		if (!scopes.length) throw new Error('[univer] write scope not allowed')
		const allowed = scopes.some((s) => rangeWithin(range, s.range))
		if (!allowed) throw new Error('[univer] clear range out of write scope')

		changeCount += 1
		if (changeCount > limits.maxChanges) throw new Error(`[univer] changes exceed limit: ${changeCount} > ${limits.maxChanges}`)
		stats.appliedClears += 1
		return bridge.clearRange(input)
	}

	const bumpChange = () => {
		changeCount += 1
		if (changeCount > limits.maxChanges) throw new Error(`[univer] changes exceed limit: ${changeCount} > ${limits.maxChanges}`)
	}

	const checkReadRange = (range: UniverAiRange, sheetId?: string, sheetName?: string) => {
		const scopes = scopeListForSheet(readScopes, sheetId, sheetName)
		if (!scopes.length) throw new Error('[univer] read scope not allowed')
		const allowed = scopes.some((s) => rangeWithin(range, s.range))
		if (!allowed) throw new Error('[univer] read range out of scope')
	}

	const checkWriteRange = (range: UniverAiRange, sheetId?: string, sheetName?: string) => {
		const scopes = scopeListForSheet(writeScopes, sheetId, sheetName)
		if (!scopes.length) throw new Error('[univer] write scope not allowed')
		const allowed = scopes.some((s) => rangeWithin(range, s.range))
		if (!allowed) throw new Error('[univer] write range out of scope')
	}

	const checkWriteCell = (row: number, col: number, sheetId?: string, sheetName?: string) => {
		const scopes = scopeListForSheet(writeScopes, sheetId, sheetName)
		if (!scopes.length) throw new Error('[univer] write scope not allowed')
		const allowed = scopes.some((s) => rangeContainsCell(s.range, row, col))
		if (!allowed) throw new Error('[univer] op out of write scope')
	}

	const checkWriteSheet = (sheetId?: string, sheetName?: string) => {
		if (!sheetId && !sheetName) {
			if (!writeScopes.length) throw new Error('[univer] write scope not allowed')
			return
		}
		const scopes = scopeListForSheet(writeScopes, sheetId, sheetName)
		if (!scopes.length) throw new Error('[univer] write scope not allowed')
	}

	const ctx: McpContext = {
		bridge,
		workbook: (bridge as any).workbook ?? null,
		readScopes,
		writeScopes,
		sheetIdToName,
		sheetNameToId,
		limits,
		stats,
		logger: opts?.logger,
		bumpChange,
		checkReadRange,
		checkWriteRange,
		checkWriteCell,
		checkWriteSheet,
	}

	const selection = resolveUniverAxToolGroups(opts.instruction ?? '', opts.toolPolicy)
	const groups = selection.groups

	const tools: AxFunction[] = [
		{
			name: 'univer.listSheets',
			description: 'List workbook sheets (sheetId + name).',
			parameters: Type.Object({}, { additionalProperties: false }),
			func: listSheets,
		},
		{
			name: 'univer.readRangeDisplay',
			description: 'Read display values for an A1 range (clipped by limits).',
			parameters: Type.Object(
				{
					sheetId: Type.Optional(Type.String()),
					a1: Type.String(),
					limits: Type.Optional(
						Type.Object(
							{
								maxRows: Type.Optional(Type.Integer()),
								maxCols: Type.Optional(Type.Integer()),
							},
							{ additionalProperties: false },
						),
					),
				},
				{ additionalProperties: false },
			),
			func: readRangeDisplay,
		},
		{
			name: 'univer.applyOpsV1',
			description: 'Apply cell ops (set/clear) by absolute 0-based (row,col).',
			parameters: Type.Object(
				{
					sheetId: Type.String(),
					ops: Type.Array(
						Type.Object(
							{
								op: Type.Union([Type.Literal('set'), Type.Literal('clear')]),
								row: Type.Integer(),
								col: Type.Integer(),
								value: Type.Optional(Type.String()),
							},
							{ additionalProperties: false },
						),
					),
				},
				{ additionalProperties: false },
			),
			func: applyOpsV1,
		},
		{
			name: 'univer.clearRange',
			description: 'Clear cell contents for a range (0-based indices).',
			parameters: Type.Object(
				{
					sheetId: Type.String(),
					range: Type.Object(
						{
							startRow: Type.Integer(),
							startCol: Type.Integer(),
							endRow: Type.Integer(),
							endCol: Type.Integer(),
						},
						{ additionalProperties: false },
					),
				},
				{ additionalProperties: false },
			),
			func: clearRange,
		},
	]

	const mcpTools = createMcpTools(ctx, groups)
	const includeLegacy = opts.toolPolicy?.includeLegacy === true
	const merged = includeLegacy ? [...tools, ...mcpTools] : mcpTools
	return { tools: merged, stats }
}

export type UniverAxToolSpec = Readonly<{ name: string; description: string }>

export function createUniverAxToolSpecs(
	instruction: string,
	policy?: UniverAxToolPolicy,
): ReadonlyArray<UniverAxToolSpec> {
	const selection = resolveUniverAxToolGroups(instruction, policy)
	const names = listMcpToolNames(selection.groups)
	const specs = names.map((name) => ({ name, description: name.replace(/_/g, ' ') }))
	if (policy?.includeLegacy) {
		specs.unshift(
			{ name: 'univer.listSheets', description: 'List workbook sheets (sheetId + name).' },
			{ name: 'univer.readRangeDisplay', description: 'Read display values for an A1 range (clipped by limits).' },
			{ name: 'univer.applyOpsV1', description: 'Apply cell ops (set/clear) by absolute 0-based (row,col).' },
			{ name: 'univer.clearRange', description: 'Clear cell contents for a range (0-based indices).' },
		)
	}
	return specs
}

export async function runUniverAxLoopback(
	ai: AxAI,
	bridge: UniverAiBridge,
	input: UniverAxLoopbackInput,
	opts?: { logger?: Logger },
): Promise<UniverAxLoopbackResult> {
	const read = normalizeA1List(input.read)
	const write = normalizeA1List(input.write ?? input.read)
	const current = String(input.current ?? read[0] ?? '').trim()
	if (!read.length) throw new Error('[univer] read scopes must be non-empty')
	if (!current) throw new Error('[univer] current scope must be provided')

	const { tools, stats } = createUniverAxTools(bridge, {
		instruction: input.instruction,
		readScopes: read,
		writeScopes: write,
		limits: input.limits,
		contractLimits: input.contractLimits,
		toolPolicy: input.toolPolicy,
		logger: opts?.logger,
	})

	const mode = input.mode ?? 'safe'
	const selection = resolveUniverAxToolGroups(input.instruction, input.toolPolicy)
	const description = [
		'You are a spreadsheet agent operating on a Univer workbook.',
		'Use tools to read ranges and apply edits. Do not guess cell values.',
		`Tool groups: ${selection.groups.join(', ')}.`,
		`Stay within writeScopes. Mode=${mode}.`,
	].join(' ')

	try {
		const program = ax(
			'instruction:string, readScopes:string[], writeScopes:string[], current:string -> summary:string',
			{ description, functions: tools },
		)
		const res = await program.forward(ai, {
			instruction: String(input.instruction ?? '').trim(),
			readScopes: read,
			writeScopes: write,
			current,
		})
		return { ok: true, summary: String((res as any)?.summary ?? ''), stats }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		opts?.logger?.warn?.('[univer] ax loopback failed', { error })
		return { ok: false, error: message, stats }
	}
}
