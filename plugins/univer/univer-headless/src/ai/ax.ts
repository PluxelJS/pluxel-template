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
	UniverAiContext,
} from '../protocol'

import type { UniverAiBridge } from './bridge'
import { parseA1Range } from './a1'
import { buildMcpToolIndexText, createMcpTools, listMcpToolSpecs, resolveMcpToolGroups } from './mcp'
import type { A1Scope, McpCache, McpContext, McpLogger, McpStats } from './mcp/context'

type Logger = McpLogger

export type UniverAxLoopbackInput = Readonly<{
	instruction: string
	scopes: Readonly<{
		read: readonly string[]
		write?: readonly string[]
		current?: string
	}>
	contexts?: Readonly<{ selections: readonly UniverAiContext[] }>
	maxRounds?: number
	mode?: 'safe' | 'aggressive'
	limits?: { maxRows?: number; maxCols?: number }
	contract?: UniverAiContractLimits
	toolPolicy?: UniverAxToolPolicy
}>

export type UniverAxLoopbackStats = Readonly<McpStats>

export type UniverAxLoopbackResult = Readonly<
	| { ok: true; summary: string; stats: UniverAxLoopbackStats; rounds: number }
	| { ok: false; error: string; stats: UniverAxLoopbackStats; rounds: number }
>

type AxToolsResult = Readonly<{
	tools: AxFunction[]
	stats: UniverAxLoopbackStats
	helpers: Readonly<{
		readRangeDisplay: (input: UniverAiReadRangeDisplayInput) => Promise<UniverAiReadRangeDisplayResult>
	}>
}>

export type UniverAxToolPolicy = UniverToolPolicy

type LoopLimits = Readonly<{ maxRows?: number; maxCols?: number }>

function truncateText(input: unknown, maxChars: number) {
	const s = String(input ?? '')
	if (s.length <= maxChars) return s
	return `${s.slice(0, Math.max(0, maxChars - 1))}…`
}

function summarizeMatrix(input: unknown, maxSampleRows = 2, maxSampleCols = 6) {
	if (!Array.isArray(input)) return input
	const rows = input.length
	const cols = Math.max(0, ...input.map((r) => (Array.isArray(r) ? r.length : 0)))
	const sample: string[][] = []
	for (let r = 0; r < Math.min(rows, maxSampleRows); r++) {
		const row = Array.isArray(input[r]) ? (input[r] as any[]) : []
		const cells: string[] = []
		for (let c = 0; c < Math.min(row.length, maxSampleCols); c++) {
			cells.push(truncateText(row[c], 48))
		}
		sample.push(cells)
	}
	return { rows, cols, sample }
}

function sanitizeToolPayload(input: unknown) {
	if (!input || typeof input !== 'object') return input
	const obj = input as Record<string, unknown>
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(obj)) {
		if (k === 'values') {
			out[k] = summarizeMatrix(v)
			continue
		}
		if (k === 'displayValues') {
			out[k] = summarizeMatrix(v)
			continue
		}
		if (k === 'ops' && Array.isArray(v)) {
			const head = v.slice(0, 3).map((x) => (typeof x === 'object' && x ? { ...(x as any) } : x))
			out[k] = { count: v.length, head }
			continue
		}
		if (k === 'matches' && Array.isArray(v)) {
			out[k] = { count: v.length, head: v.slice(0, 5) }
			continue
		}
		if ((k === 'ranges' || k === 'items') && Array.isArray(v)) {
			out[k] = { count: v.length, head: v.slice(0, 5) }
			continue
		}
		if (k === 'updates' && Array.isArray(v)) {
			const head = v.slice(0, 3).map((x) => {
				if (!x || typeof x !== 'object') return x
				const y = { ...(x as any) }
				if ('values' in y) y.values = summarizeMatrix((y as any).values)
				return y
			})
			out[k] = { count: v.length, head }
			continue
		}
		if (k === 'byA1' && v && typeof v === 'object' && !Array.isArray(v)) {
			const keys = Object.keys(v as any)
			out[k] = { count: keys.length, head: keys.slice(0, 6) }
			continue
		}
		if (typeof v === 'string') {
			out[k] = truncateText(v, 400)
			continue
		}
		out[k] = v
	}
	return out
}

function wrapAxTool(tool: AxFunction, logger?: Logger): AxFunction {
	const fn = tool.func
	if (typeof fn !== 'function') return tool
	const name = String(tool.name ?? '')
	const hintForError = (message: string) => {
		if (message.includes('read sheet not allowed')) {
			return 'You can only read sheets listed in readScopes. Add that sheet to context (pin selection) or pass sheetId/sheetName matching allowed sheets.'
		}
		if (message.includes('read range out of scope')) {
			return 'Read was outside the allowed scope. Prefer reading within the user-provided sheet(s); use smaller targeted ranges or adjust A1.'
		}
		if (message.includes('set_range_data invalid values') || message.includes('invalid values matrix')) {
			return 'set_range_data requires a dense 2D matrix exactly matching the target range size (rows x cols). If you need different formulas per row/col, provide a full matrix of formula strings.'
		}
		if (message.includes('fill_formula')) {
			return 'fill_formula requires an A1 formula string starting with "=". Use $ to lock rows/cols that should not shift.'
		}
		if (message.includes('set_ranges_data') || message.includes('get_ranges_data')) {
			return 'Batch tools accept arrays: get_ranges_data({ranges:[...]}) and set_ranges_data({updates:[...]}). Each item must have a1 or range and optional sheetId/sheetName.'
		}
		if (message.includes('sheet not found')) {
			return 'The referenced sheetId/sheetName was not found. Call get_sheets or univer.listSheets to discover valid sheet ids/names, then retry with the correct sheet.'
		}
		if (message.includes('invalid A1') || message.includes('invalid a1')) {
			return 'Use a valid A1 notation like Sheet1!A1:B10 or A1:B10 (with current sheet). Avoid column-only forms like T:T.'
		}
		if (message.includes('invalid regex')) {
			return 'Provide a valid regex pattern, or change match mode to "contains" or "exact".'
		}
		if (message.includes('changes exceed limit') || message.includes('ops exceed limit')) {
			return 'You hit contract limits. Batch fewer edits per step, or reduce the change set.'
		}
		return 'Adjust the tool input and retry. If needed, call get_sheets/get_active_unit_id first to confirm sheet ids.'
	}
	return {
		...tool,
		func: async (input: any) => {
			const t0 = Date.now()
			const logCall = logger?.debug ?? logger?.info
			logCall?.('univer tool call ({name})', { name, input: sanitizeToolPayload(input) })
			try {
				const res = await fn(input)
				const dt = Date.now() - t0
				const logOk = logger?.debug ?? logger?.info
				logOk?.('univer tool ok ({name}) ({ms}ms)', { name, ms: dt, output: sanitizeToolPayload(res) })
				return res
			} catch (error) {
				const dt = Date.now() - t0
				logger?.warn?.('univer tool failed ({name}) ({ms}ms)', { name, ms: dt, error })
				const message = error instanceof Error ? error.message : String(error)
				return { ok: false, error: message, hint: hintForError(message) }
			}
		},
	}
}

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

function resolveLoopLimits(input: {
	limits?: LoopLimits
	instruction?: string
	mode?: 'safe' | 'aggressive'
	groups?: readonly UniverToolGroup[]
}): Required<LoopLimits> {
	const userRows = input.limits?.maxRows
	const userCols = input.limits?.maxCols

	// Keep a conservative default; only auto-expand when we are likely doing data analysis/normalization.
	const base = {
		maxRows: typeof userRows === 'number' && Number.isFinite(userRows) ? clampInt(userRows, 1, 2000) : 40,
		maxCols: typeof userCols === 'number' && Number.isFinite(userCols) ? clampInt(userCols, 1, 2000) : 16,
	}

	if (typeof userRows === 'number' || typeof userCols === 'number') return base

	const text = String(input.instruction ?? '')
	const isAggressive = input.mode === 'aggressive'
	const groups = new Set(input.groups ?? [])

	const looksLikeDataWork =
		/(汇总|统计|合计|总计|平均|均值|最大|最小|去重|去空|清洗|标准化|规范化|匹配|映射|分类|分组|透视|拆分|合并|填充|补全)/.test(text) ||
		/\b(sum|total|avg|mean|max|min|dedup|normalize|clean|group|pivot|join|merge|fill)\b/i.test(text)

	const wantsStructureOrStyle =
		groups.has('structure') ||
		groups.has('style') ||
		/(合并|merge|插入|删除行|删除列|行高|列宽|加粗|字体|颜色|边框|对齐|格式|style|format|bold|italic|underline)\b/i.test(text)

	if (looksLikeDataWork && !wantsStructureOrStyle) {
		return { maxRows: isAggressive ? 120 : 80, maxCols: isAggressive ? 32 : 24 }
	}

	return base
}

function escapeCellText(input: string, maxChars: number) {
	const s = String(input ?? '').replace(/\r?\n/g, ' ').trim()
	if (s.length <= maxChars) return s
	return `${s.slice(0, Math.max(0, maxChars - 1))}…`
}

function matrixPreviewTSV(values: string[][], opts?: { maxRows?: number; maxCols?: number; maxCellChars?: number }): string {
	const maxRows = clampInt(opts?.maxRows, 1, 50)
	const maxCols = clampInt(opts?.maxCols, 1, 50)
	const maxCellChars = clampInt(opts?.maxCellChars, 8, 120)

	const out: string[] = []
	const rowCount = values.length
	for (let r = 0; r < Math.min(rowCount, maxRows); r++) {
		const row = values[r] ?? []
		const cells: string[] = []
		for (let c = 0; c < Math.min(row.length, maxCols); c++) {
			cells.push(escapeCellText(String(row[c] ?? ''), maxCellChars))
		}
		out.push(cells.join('\t'))
	}
	return out.join('\n')
}

async function buildContextPackText(
	readRangeDisplay: (input: UniverAiReadRangeDisplayInput) => Promise<UniverAiReadRangeDisplayResult>,
	scopes: readonly string[],
	limits: Required<LoopLimits>,
	selections?: readonly UniverAiContext[],
): Promise<string> {
	const picked = scopes.filter(Boolean).slice(0, 4)
	if (!picked.length) return ''

	const selectionMap = new Map<string, UniverAiContext>()
	for (const s of selections ?? []) {
		const a1 = String(s?.selection?.a1 ?? '').trim()
		if (!a1) continue
		selectionMap.set(a1, s)
	}

	const lines: string[] = []
	for (const a1 of picked) {
		try {
			const sel = selectionMap.get(a1)
			if (sel?.selection?.display && Array.isArray(sel.selection.display)) {
				const values = sel.selection.display
				const rows = values.length
				const cols = Math.max(0, ...values.map((r) => (Array.isArray(r) ? r.length : 0)))
				lines.push(
					`- ${a1} (sheetId=${String(sel.selection.sheetId ?? '') || 'unknown'}, size=${rows}x${cols}${sel.selection.truncated ? ', truncated' : ''})`,
				)
				const preview = matrixPreviewTSV(values, { maxRows: 8, maxCols: 10, maxCellChars: 32 })
				if (preview) lines.push(preview)
				continue
			}

			const res = await readRangeDisplay({ a1, limits })
			const rows = res.values.length
			const cols = Math.max(0, ...res.values.map((r) => r.length))
			lines.push(`- ${a1} (sheetId=${res.sheetId}, size=${rows}x${cols}${res.truncated ? ', truncated' : ''})`)
			const preview = matrixPreviewTSV(res.values, { maxRows: 8, maxCols: 10, maxCellChars: 32 })
			if (preview) lines.push(preview)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			lines.push(`- ${a1} (read failed: ${msg})`)
		}
	}
	return lines.join('\n')
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
		/**
		 * Optional "current" scope used as the default sheet for tool calls that omit sheetId/sheetName.
		 * Example: `Sheet1!A1:D40`.
		 */
		current?: string
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

	const defaultSheetNameFromScopes = (() => {
		const fromCurrent = String(opts.current ?? '').trim()
		if (fromCurrent) {
			try {
				const parsed = parseA1Range(fromCurrent)
				if (parsed.sheetName) return parsed.sheetName
			} catch {
				// ignore
			}
		}
		for (const s of readScopes) {
			if (s.sheetName) return s.sheetName
		}
		return undefined
	})()

	const activeSheetName = (() => {
		try {
			const wb = (bridge as any)?.workbook
			const active = wb?.getActiveSheet?.()
			const name = typeof active?.getName === 'function' ? String(active.getName()) : ''
			return name.trim() || undefined
		} catch {
			return undefined
		}
	})()

	const defaultSheetName = defaultSheetNameFromScopes ?? activeSheetName
	const defaultSheetId = defaultSheetName ? sheetNameToId.get(defaultSheetName) : undefined

	const allowedReadSheetIds = new Set(readScopes.map((s) => s.sheetId).filter(Boolean) as string[])
	const allowedReadSheetNames = new Set(readScopes.map((s) => s.sheetName).filter(Boolean) as string[])
	const allowedSheetsLabel = (() => {
		const parts: string[] = []
		for (const id of allowedReadSheetIds) parts.push(sheetIdToName.get(id) ?? id)
		for (const name of allowedReadSheetNames) if (!parts.includes(name)) parts.push(name)
		return parts.slice(0, 12).join(', ')
	})()
	const isAllowedReadSheet = (sheetId?: string, sheetName?: string) => {
		const sid = String(sheetId ?? '').trim()
		const sname = String(sheetName ?? '').trim()
		if (allowedReadSheetIds.size) {
			if (sid) return allowedReadSheetIds.has(sid)
			if (sname) {
				const mapped = sheetNameToId.get(sname)
				return mapped ? allowedReadSheetIds.has(mapped) : false
			}
			return false
		}
		// Fallback: compare by name only.
		if (allowedReadSheetNames.size) {
			if (sname) return allowedReadSheetNames.has(sname)
			return false
		}
		// No sheet info from scopes: fall back to strict range-based checks.
		return false
	}

	const limits = resolveContractLimits(opts.contract)
	let changeCount = 0
	const stats: McpStats = {
		toolCalls: 0,
		appliedOps: 0,
		appliedClears: 0,
		readCalls: 0,
	}

	let cacheEpoch = 0
	const cacheMap = new Map<string, unknown>()
	const cache: McpCache = {
		get: (key) => cacheMap.get(key),
		set: (key, value) => void cacheMap.set(key, value),
		clear: () => void cacheMap.clear(),
		epoch: cacheEpoch,
	}
	const bumpWriteEpoch = () => {
		cacheEpoch += 1
		cache.epoch = cacheEpoch
		cacheMap.clear()
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
		const sheetName =
			parsed.sheetName ??
			(input.sheetId ? sheetIdToName.get(input.sheetId) : undefined) ??
			defaultSheetName
		const sheetId =
			String(input.sheetId ?? '').trim() ||
			(sheetName ? sheetNameToId.get(sheetName) : undefined) ||
			defaultSheetId
		if (!isAllowedReadSheet(sheetId, sheetName)) {
			// If we cannot determine sheet allow-list (e.g. scopes without sheet),
			// fall back to strict range checks on any available scopes.
			const scopes = scopeListForSheet(readScopes, sheetId, sheetName)
			if (!scopes.length) {
				throw new Error(
					allowedSheetsLabel ? `[univer] read sheet not allowed (allowed: ${allowedSheetsLabel})` : '[univer] read sheet not allowed',
				)
			}
			const allowed = scopes.some((s) => rangeWithin(parsed.range, s.range))
			if (!allowed) throw new Error('[univer] read range out of scope')
		}

		const normalizedA1 =
			!parsed.sheetName && defaultSheetName && !a1.includes('!') ? `${defaultSheetName}!${parsed.a1}` : parsed.a1
		const next: UniverAiReadRangeDisplayInput = {
			...input,
			...(sheetId && !input.sheetId ? { sheetId } : {}),
			a1: normalizedA1,
			limits: input.limits ?? opts.limits,
		}
		const limRows = typeof next.limits?.maxRows === 'number' ? next.limits.maxRows : ''
		const limCols = typeof next.limits?.maxCols === 'number' ? next.limits.maxCols : ''
		const key = `${cache.epoch}|univer.readRangeDisplay|${String(next.sheetId ?? '')}|${next.a1}|${limRows}x${limCols}`
		if (cacheMap.has(key)) return cacheMap.get(key) as UniverAiReadRangeDisplayResult
		const value = bridge.readRangeDisplay(next)
		cacheMap.set(key, value)
		return value
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

		checkCanChange()
		checkCanApplyOps(ops.length)

		const res = bridge.applyOpsV1(input)
		changeCount += 1
		bumpWriteEpoch()
		stats.appliedOps += res.appliedOps
		return res
	}

	const clearRange = async (input: UniverAiClearRangeInput): Promise<UniverAiClearRangeResult> => {
		stats.toolCalls++
		const sheetId = String(input?.sheetId ?? '').trim()
		if (!sheetId) throw new Error('[univer] sheetId required')
		const range = input?.range as UniverRange
		if (!range) throw new Error('[univer] range required')

		if (changeCount + 1 > limits.maxChanges) {
			throw new Error(`[univer] changes exceed limit: ${changeCount + 1} > ${limits.maxChanges}`)
		}
		stats.appliedClears += 1
		const res = bridge.clearRange(input)
		changeCount += 1
		bumpWriteEpoch()
		return res
	}

	const checkCanChange = () => {
		if (changeCount + 1 > limits.maxChanges) {
			throw new Error(`[univer] changes exceed limit: ${changeCount + 1} > ${limits.maxChanges}`)
		}
	}

	const checkCanApplyOps = (ops: number) => {
		const n = typeof ops === 'number' && Number.isFinite(ops) ? Math.floor(ops) : 0
		if (n <= 0) return
		const nextOps = stats.appliedOps + n
		if (nextOps > limits.maxOps) throw new Error(`[univer] ops exceed limit: ${nextOps} > ${limits.maxOps}`)
	}

	const bumpChange = () => {
		checkCanChange()
		changeCount += 1
		bumpWriteEpoch()
	}

	const checkReadRange = (range: UniverRange, sheetId?: string, sheetName?: string) => {
		const resolvedSheetName = sheetName ?? (!sheetId ? defaultSheetName : undefined)
		const resolvedSheetId = sheetId ?? (!sheetId && resolvedSheetName ? sheetNameToId.get(resolvedSheetName) : undefined) ?? defaultSheetId

		// Prefer sheet-level allow list (best UX).
		if (isAllowedReadSheet(resolvedSheetId, resolvedSheetName)) return

		// Fallback: strict range-based check when allow-list is not available.
		const scopes = scopeListForSheet(readScopes, resolvedSheetId, resolvedSheetName)
		if (!scopes.length) {
			throw new Error(
				allowedSheetsLabel ? `[univer] read sheet not allowed (allowed: ${allowedSheetsLabel})` : '[univer] read sheet not allowed',
			)
		}
		const allowed = scopes.some((s) => rangeWithin(range, s.range))
		if (!allowed) {
			throw new Error('[univer] read range out of scope')
		}
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
		defaultSheetId,
		defaultSheetName,
		viewLimits: {
			maxRows: typeof opts.limits?.maxRows === 'number' && Number.isFinite(opts.limits.maxRows) ? Math.max(1, Math.floor(opts.limits.maxRows)) : 40,
			maxCols: typeof opts.limits?.maxCols === 'number' && Number.isFinite(opts.limits.maxCols) ? Math.max(1, Math.floor(opts.limits.maxCols)) : 16,
		},
		limits,
		stats,
		logger: opts?.logger,
		cache,
		checkCanChange,
		checkCanApplyOps,
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
			parameters: Type.Object({}, { additionalProperties: false }) as any,
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
			) as any,
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
			) as any,
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
			) as any,
			func: clearRange,
		},
	]

	const mcpTools = createMcpTools(ctx, groups)
	const includeLegacy = opts.toolPolicy?.includeLegacy === true
	const mergedRaw = includeLegacy ? [...tools, ...mcpTools] : mcpTools
	const merged = mergedRaw.map((t) => wrapAxTool(t, opts.logger))
	return {
		tools: merged,
		stats,
		helpers: {
			readRangeDisplay,
		},
	}
}

export type UniverAxToolSpec = Readonly<{ name: string; description: string }>

export function createUniverAxToolSpecs(
	instruction: string,
	policy?: UniverAxToolPolicy,
): ReadonlyArray<UniverAxToolSpec> {
	const selection = resolveUniverAxToolGroups(instruction, policy)
	const specs: UniverAxToolSpec[] = listMcpToolSpecs(selection.groups).map((spec) => ({
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
	// Safety cap only: the model should stop when it's done; we just prevent runaway loops.
	const HARD_MAX_STEPS = 80

	const read = normalizeA1List(input.scopes.read)
	const write = normalizeA1List(input.scopes.write ?? input.scopes.read)
	const current = String(input.scopes.current ?? read[0] ?? '').trim()
	if (!read.length) throw new Error('[univer] read scopes must be non-empty')
	if (!current) throw new Error('[univer] current scope must be provided')

	const selection = resolveUniverAxToolGroups(input.instruction, input.toolPolicy)
	const effectiveLimits = resolveLoopLimits({
		limits: input.limits,
		instruction: input.instruction,
		mode: input.mode,
		groups: selection.groups,
	})

	const { tools, stats, helpers } = createUniverAxTools(bridge, {
		instruction: input.instruction,
		current,
		readScopes: read,
		writeScopes: write,
		limits: effectiveLimits,
		contract: input.contract,
		toolPolicy: input.toolPolicy,
		logger: opts?.logger,
	})

	const mode = input.mode ?? 'safe'
	const toolIndexMode: UniverToolIndexMode =
		input.toolPolicy?.toolIndex ?? (selection.groups.length <= 2 ? 'tools' : 'groups')
	const toolIndexText = buildMcpToolIndexText(selection.groups, {
		mode: toolIndexMode,
		includePresets: true,
	})
	const contextPackScopes = [current, ...read.filter((s) => s !== current)]

	// NOTE: Ax uses "maxSteps" to limit tool-call iterations. We map our legacy `maxRounds` to it.
	// Don't enforce a minimum here; some use cases may intentionally use a small cap.
	// When omitted, we default to the hard cap so the model can decide when to stop.
	const maxSteps = clampInt(input.maxRounds ?? HARD_MAX_STEPS, 1, HARD_MAX_STEPS)

	let toolCallsAtStart = stats.toolCalls
	try {
		const contextPackText = await buildContextPackText(
			helpers.readRangeDisplay,
			contextPackScopes,
			effectiveLimits,
			input.contexts?.selections,
		)
		// Exclude bootstrap reads (context pack) from "rounds" accounting.
		toolCallsAtStart = stats.toolCalls

		const description = [
			'You are a spreadsheet agent operating on a Univer workbook.',
			'Use tools to read ranges and apply edits. Do not guess cell values.',
			'Stop as soon as you have completed the requested changes and verified the results; do not keep iterating for extra improvements.',
			'Tool errors: tools may return {ok:false,error,hint}; use the hint to fix inputs and retry. Do not crash.',
			'Read policy: you may read any cells within the sheet(s) referenced by readScopes; cross-sheet reads require being listed in readScopes.',
			'Reading policy note: keep reads small and targeted; prefer search_cells/summary reads over whole-sheet dumps.',
			'Write policy: after you write, ALWAYS verify by reading back the minimal affected output range and confirm it matches the intent.',
			'Formula policy: prefer fill_formula to apply formulas over a range (it shifts relative refs per-cell). Avoid using auto_fill for formulas because it only repeats source values.',
			'Batch policy: when you need multiple disjoint reads/writes, prefer get_ranges_data / set_ranges_data to reduce roundtrips. get_ranges_data returns order+byA1 (use order to iterate).',
			contextPackText ? `Context pack (top-left preview):\n${contextPackText}` : null,
			`Tool groups: ${selection.groups.join(', ')}.`,
			toolIndexText ? `Tool index:\n${toolIndexText}` : null,
			write.length ? `Editable ranges (user review): ${write.join(', ')}.` : null,
			'Prefer batched edits; minimize tool calls when setting many cells.',
			`Mode=${mode}.`,
		]
			.filter(Boolean)
			.join('\n')

		const logPrompt = opts?.logger?.debug ?? opts?.logger?.info
		logPrompt?.('univer ax prompt', {
			mode,
			requestedMaxRounds: input.maxRounds,
			maxSteps,
			readScopes: read,
			writeScopes: write,
			current,
			groups: selection.groups,
			groupReason: selection.reason,
			toolIndexMode,
			toolCount: tools.length,
			toolNames: tools.map((t) => String((t as any)?.name ?? '')).filter(Boolean).slice(0, 80),
			contextPackScopes,
			contextPackPreview: truncateText(contextPackText, 2000),
			systemPromptPreview: truncateText(description, 2400),
		})

		const program = ax(
			'instruction:string, readScopes:string[], writeScopes:string[], current:string -> summary:string',
			{ description, functions: tools },
		)
		const res = await program.forward(ai, {
			instruction: String(input.instruction ?? '').trim(),
			readScopes: read,
			writeScopes: write,
			current,
		}, { maxSteps })

		const rounds = Math.max(1, stats.toolCalls - toolCallsAtStart)
		return { ok: true, summary: String((res as any)?.summary ?? ''), stats, rounds }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		opts?.logger?.warn?.('[univer] ax loopback failed', { error })
		const rounds = Math.max(1, stats.toolCalls - toolCallsAtStart)
		return { ok: false, error: message, stats, rounds }
	}
}
