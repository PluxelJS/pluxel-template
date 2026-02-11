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
	UniverAiReadRangeDisplayInput,
	UniverAiReadRangeDisplayResult,
	UniverRange,
	UniverToolGroup,
	UniverToolIndexMode,
	UniverToolPolicy,
	UniverAiContractLimits,
} from '../protocol'

import type { UniverAiBridge } from './bridge'
import { parseA1Range } from './a1'
import { buildMcpToolIndexText, createMcpTools, listMcpToolSpecs, resolveMcpToolGroups } from './mcp'
import type { A1Scope, McpContext, McpLogger, McpStats } from './mcp/context'

type Logger = McpLogger

export type UniverAxLoopbackInput = Readonly<{
	instruction: string
	scopes: Readonly<{
		read: readonly string[]
		write?: readonly string[]
		current?: string
	}>
	maxRounds?: number
	mode?: 'safe' | 'aggressive'
	limits?: { maxRows?: number; maxCols?: number }
	contract?: UniverAiContractLimits
	toolPolicy?: UniverAxToolPolicy
}>

export type UniverAxLoopbackStats = Readonly<McpStats>

export type UniverAxLoopbackResult = Readonly<
	| { ok: true; summary: string; stats: UniverAxLoopbackStats }
	| { ok: false; error: string; stats: UniverAxLoopbackStats }
>

type AxToolsResult = Readonly<{ tools: AxFunction[]; stats: UniverAxLoopbackStats }>

export type UniverAxToolPolicy = UniverToolPolicy

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

function rangeWithin(a: UniverRange, b: UniverRange) {
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

function resolveContractLimits(input?: UniverAiContractLimits) {
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

export function resolveUniverAxToolGroups(
	instruction: string,
	policy?: UniverAxToolPolicy,
): { groups: UniverToolGroup[]; reason: string } {
	return resolveMcpToolGroups(instruction, policy)
}

export function createUniverAxTools(
	bridge: UniverAiBridge,
	opts: {
		instruction?: string
		readScopes: readonly string[]
		writeScopes: readonly string[]
		limits?: { maxRows?: number; maxCols?: number }
		contract?: UniverAiContractLimits
		toolPolicy?: UniverAxToolPolicy
		logger?: Logger
	},
): AxToolsResult {
	const readList = normalizeA1List(opts.readScopes)
	const writeList = normalizeA1List(opts.writeScopes)
	const effectiveWrite = writeList.length ? writeList : readList
	if (!readList.length) throw new Error('[univer] read scopes must be non-empty')

	const readScopes = toScopes(readList)
	const writeScopes = toScopes(effectiveWrite)

	const { sheetIdToName, sheetNameToId } = buildSheetMaps(bridge)
	attachSheetIds(readScopes, sheetNameToId)
	attachSheetIds(writeScopes, sheetNameToId)

	const limits = resolveContractLimits(opts.contract)
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

		for (const op of ops) {
			const row = (op as any).row
			const col = (op as any).col
			if (!Number.isInteger(row) || !Number.isInteger(col)) throw new Error('[univer] op row/col must be integers')
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
		const range = input?.range as UniverRange
		if (!range) throw new Error('[univer] range required')

		changeCount += 1
		if (changeCount > limits.maxChanges) throw new Error(`[univer] changes exceed limit: ${changeCount} > ${limits.maxChanges}`)
		stats.appliedClears += 1
		return bridge.clearRange(input)
	}

	const bumpChange = () => {
		changeCount += 1
		if (changeCount > limits.maxChanges) throw new Error(`[univer] changes exceed limit: ${changeCount} > ${limits.maxChanges}`)
	}

	const checkReadRange = (range: UniverRange, sheetId?: string, sheetName?: string) => {
		const scopes = scopeListForSheet(readScopes, sheetId, sheetName)
		if (!scopes.length) throw new Error('[univer] read scope not allowed')
		const allowed = scopes.some((s) => rangeWithin(range, s.range))
		if (!allowed) throw new Error('[univer] read range out of scope')
	}

	const checkWriteRange = (range: UniverRange, sheetId?: string, sheetName?: string) => {
		void range
		void sheetId
		void sheetName
	}

	const checkWriteCell = (row: number, col: number, sheetId?: string, sheetName?: string) => {
		void row
		void col
		void sheetId
		void sheetName
	}

	const checkWriteSheet = (sheetId?: string, sheetName?: string) => {
		void sheetId
		void sheetName
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
	const specs = listMcpToolSpecs(selection.groups).map((spec) => ({
		name: spec.name,
		description: spec.description,
	}))
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
	const read = normalizeA1List(input.scopes.read)
	const write = normalizeA1List(input.scopes.write ?? input.scopes.read)
	const current = String(input.scopes.current ?? read[0] ?? '').trim()
	if (!read.length) throw new Error('[univer] read scopes must be non-empty')
	if (!current) throw new Error('[univer] current scope must be provided')

	const { tools, stats } = createUniverAxTools(bridge, {
		instruction: input.instruction,
		readScopes: read,
		writeScopes: write,
		limits: input.limits,
		contract: input.contract,
		toolPolicy: input.toolPolicy,
		logger: opts?.logger,
	})

	const mode = input.mode ?? 'safe'
	const selection = resolveUniverAxToolGroups(input.instruction, input.toolPolicy)
	const toolIndexMode: UniverToolIndexMode = input.toolPolicy?.toolIndex ?? 'tools'
	const toolIndexText = buildMcpToolIndexText(selection.groups, {
		mode: toolIndexMode,
		includePresets: true,
	})
	const description = [
		'You are a spreadsheet agent operating on a Univer workbook.',
		'Use tools to read ranges and apply edits. Do not guess cell values.',
		`Tool groups: ${selection.groups.join(', ')}.`,
		toolIndexText ? `Tool index:\n${toolIndexText}` : null,
		write.length ? `Editable ranges (user review): ${write.join(', ')}.` : null,
		`Mode=${mode}.`,
	]
		.filter(Boolean)
		.join('\n')

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
