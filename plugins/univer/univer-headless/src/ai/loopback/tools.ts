import type { AxFunction } from '@ax-llm/ax'
import type {
	UniverAiReadRangeDisplayInput,
	UniverAiReadRangeDisplayResult,
	UniverRange,
} from '../../protocol'

import type { UniverAiBridge } from '../bridge'
import { parseA1Range } from '../a1'
import { formatSheetNameForA1 } from '../a1'
import { createMcpTools } from '../mcp'
import type { McpCache, McpContext, McpStats } from '../mcp/context'
import { UNIVER_AI_DEFAULT_CONTRACT_LIMITS } from '../../protocol'
import { attachSheetIds, buildSheetMaps, normalizeA1List, rangeWithin, toScopes } from './scopes'
import { scopesForRequest } from './permissions'
import { wrapAxTool } from './tool-wrap'
import type { UniverAxOtel } from './otel'
import { createUniverAxOtelInstruments } from './otel'
import type { UniverToolGroup } from '../../protocol'
import { UNIVER_LOOPBACK_TOOL_GROUPS } from './policy'
import { clampInt, parseEnvInt } from '../ints'

function resolveContractLimits() {
	const base = UNIVER_AI_DEFAULT_CONTRACT_LIMITS
	const envMaxChanges = parseEnvInt('UNIVER_AI_MAX_CHANGES')
	const envMaxOps = parseEnvInt('UNIVER_AI_MAX_OPS')
	return {
		maxChanges: clampInt(envMaxChanges ?? base.maxChanges, 1, 500),
		maxOps: clampInt(envMaxOps ?? base.maxOps, 1, 200_000),
	} as const
}

export type AxToolsResult = Readonly<{
	tools: AxFunction[]
	stats: Readonly<McpStats>
	helpers: Readonly<{
		/** Scoped + cached display reader used for context-pack bootstrap. */
		readRangeDisplay: (input: UniverAiReadRangeDisplayInput) => Promise<UniverAiReadRangeDisplayResult>
	}>
}>

export function createUniverAxTools(
	bridge: UniverAiBridge,
	opts: {
		/**
		 * Optional "current" scope used as the default sheet for tool calls that omit sheetId/sheetName.
		 * Example: `Sheet1!A1:D40`.
		 */
		current?: string
		readScopes: readonly string[]
		writeScopes: readonly string[]
		/** Limit the returned matrix size for read tools (get_range_data/get_ranges_data/search, etc.). */
		viewLimits?: Readonly<{ maxRows: number; maxCols: number }>
		/** Limit tool surface area by selecting only these MCP tool groups. */
		groups?: readonly UniverToolGroup[]
		otel?: UniverAxOtel
	},
): AxToolsResult {
	const readList = normalizeA1List(opts.readScopes)
	const writeList = normalizeA1List(opts.writeScopes)
	if (!readList.length) throw new Error('[univer] read scopes must be non-empty')

	const readScopes = toScopes(readList)
	const writeScopes = toScopes(writeList)

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
			const wb = bridge.workbook
			const active = wb?.getActiveSheet?.()
			const name = typeof active?.getName === 'function' ? String(active.getName()) : ''
			return name.trim() || undefined
		} catch {
			return undefined
		}
	})()

	const defaultSheetName = defaultSheetNameFromScopes ?? activeSheetName
	const activeSheetId = (() => {
		try {
			const wb = bridge.workbook
			const active: any = wb?.getActiveSheet?.()
			const id = typeof active?.getSheetId === 'function' ? String(active.getSheetId()) : ''
			return id.trim() || undefined
		} catch {
			return undefined
		}
	})()
	const defaultSheetId = (defaultSheetName ? sheetNameToId.get(defaultSheetName) : undefined) ?? activeSheetId

	const allowedReadSheetIds = new Set(readScopes.map((s) => s.sheetId).filter(Boolean) as string[])
	const allowedReadSheetNames = new Set(readScopes.map((s) => s.sheetName).filter(Boolean) as string[])
	const allowedReadScopesLabel = readList.slice(0, 12).join('; ')
	const allowedReadSheetsLabel = (() => {
		const parts: string[] = []
		for (const id of allowedReadSheetIds) parts.push(sheetIdToName.get(id) ?? id)
		for (const name of allowedReadSheetNames) if (!parts.includes(name)) parts.push(name)
		return parts.slice(0, 12).join(', ')
	})()

	const allowedWriteSheetIds = new Set(writeScopes.map((s) => s.sheetId).filter(Boolean) as string[])
	const allowedWriteSheetNames = new Set(writeScopes.map((s) => s.sheetName).filter(Boolean) as string[])
	const allowedWriteScopesLabel = writeList.slice(0, 12).join('; ')
	const allowedWriteSheetsLabel = (() => {
		const parts: string[] = []
		for (const id of allowedWriteSheetIds) parts.push(sheetIdToName.get(id) ?? id)
		for (const name of allowedWriteSheetNames) if (!parts.includes(name)) parts.push(name)
		return parts.slice(0, 12).join(', ')
	})()

	const limits = resolveContractLimits()
	let changeCount = 0
	const stats: McpStats = {
		toolCalls: 0,
		appliedOps: 0,
		appliedClears: 0,
		readCalls: 0,
		callSeq: 0,
		toolErrors: 0,
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
		checkReadRange(parsed.range, sheetId, sheetName)

		const normalizedA1 =
			!parsed.sheetName && defaultSheetName && !a1.includes('!')
				? `${formatSheetNameForA1(defaultSheetName)}!${parsed.a1}`
				: parsed.a1
		const next: UniverAiReadRangeDisplayInput = {
			...input,
			...(sheetId && !input.sheetId ? { sheetId } : {}),
			a1: normalizedA1,
			limits: input.limits,
		}
		const limRows = typeof next.limits?.maxRows === 'number' ? next.limits.maxRows : ''
		const limCols = typeof next.limits?.maxCols === 'number' ? next.limits.maxCols : ''
		const key = `${cache.epoch}|univer.readRangeDisplay|${String(next.sheetId ?? '')}|${next.a1}|${limRows}x${limCols}`
		if (cacheMap.has(key)) return cacheMap.get(key) as UniverAiReadRangeDisplayResult
		const value = bridge.readRangeDisplay(next)
		cacheMap.set(key, value)
		return value
	}

	const checkCanChange = () => {
		if (changeCount + 1 > limits.maxChanges) {
			throw new Error(
				`[univer] changes exceed limit: ${changeCount + 1} > ${limits.maxChanges}. Prefer batching writes with set_ranges_data (many updates in 1 change). If needed, increase UNIVER_AI_MAX_CHANGES.`,
			)
		}
	}

	const checkCanApplyOps = (ops: number) => {
		const n = typeof ops === 'number' && Number.isFinite(ops) ? Math.floor(ops) : 0
		if (n <= 0) return
		const nextOps = stats.appliedOps + n
		if (nextOps > limits.maxOps)
			throw new Error(
				`[univer] ops exceed limit: ${nextOps} > ${limits.maxOps}. Reduce total written cells per run, prefer fewer/larger batch writes, or split the instruction. If needed, increase UNIVER_AI_MAX_OPS.`,
			)
	}

	const bumpChange = () => {
		checkCanChange()
		changeCount += 1
		bumpWriteEpoch()
	}

	const checkReadRange = (range: UniverRange, sheetId?: string, sheetName?: string) => {
		const resolvedSheetName = sheetName ?? (!sheetId ? defaultSheetName : undefined)
		const resolvedSheetId = sheetId ?? (!sheetId && resolvedSheetName ? sheetNameToId.get(resolvedSheetName) : undefined) ?? defaultSheetId

		const scopes = scopesForRequest(readScopes, {
			sheetId: resolvedSheetId,
			sheetName: resolvedSheetName,
			defaultSheetId,
			defaultSheetName,
			sheetIdToName,
		})
		if (!scopes.length) {
			const requested = resolvedSheetName || resolvedSheetId || 'unknown'
			throw new Error(
				allowedReadSheetsLabel
					? `[univer] read sheet not allowed (requested: ${requested}; allowed sheets: ${allowedReadSheetsLabel})`
					: '[univer] read sheet not allowed',
			)
		}
		const allowed = scopes.some((s) => rangeWithin(range, s.range))
		if (!allowed) {
			throw new Error(
				allowedReadScopesLabel ? `[univer] read range out of scope (allowed scopes: ${allowedReadScopesLabel})` : '[univer] read range out of scope',
			)
		}
	}

	const checkWriteRange = (range: UniverRange, sheetId?: string, sheetName?: string) => {
		if (!writeList.length) {
			throw new Error('[univer] write not permitted (no write scopes)')
		}
		const resolvedSheetName = sheetName ?? (!sheetId ? defaultSheetName : undefined)
		const resolvedSheetId = sheetId ?? (!sheetId && resolvedSheetName ? sheetNameToId.get(resolvedSheetName) : undefined) ?? defaultSheetId

		const scopes = scopesForRequest(writeScopes, {
			sheetId: resolvedSheetId,
			sheetName: resolvedSheetName,
			defaultSheetId,
			defaultSheetName,
			sheetIdToName,
		})
		if (!scopes.length) {
			const requested = resolvedSheetName || resolvedSheetId || 'unknown'
			throw new Error(
				allowedWriteSheetsLabel
					? `[univer] write sheet not allowed (requested: ${requested}; allowed sheets: ${allowedWriteSheetsLabel})`
					: '[univer] write sheet not allowed',
			)
		}
		const allowed = scopes.some((s) => rangeWithin(range, s.range))
		if (!allowed) {
			throw new Error(
				allowedWriteScopesLabel
					? `[univer] write range out of scope (allowed scopes: ${allowedWriteScopesLabel})`
					: '[univer] write range out of scope',
			)
		}
	}

	const checkWriteCell = (row: number, col: number, sheetId?: string, sheetName?: string) => {
		if (!Number.isInteger(row) || !Number.isInteger(col)) throw new Error('[univer] row/col must be integers')
		checkWriteRange({ startRow: row, startCol: col, endRow: row, endCol: col }, sheetId, sheetName)
	}

	const checkWriteSheet = (sheetId?: string, sheetName?: string) => {
		if (!writeList.length) {
			throw new Error('[univer] write not permitted (no write scopes)')
		}
		const resolvedSheetName = sheetName ?? (!sheetId ? defaultSheetName : undefined)
		const resolvedSheetId = sheetId ?? (!sheetId && resolvedSheetName ? sheetNameToId.get(resolvedSheetName) : undefined) ?? defaultSheetId
		if (!resolvedSheetId && !resolvedSheetName) {
			throw new Error('[univer] write sheet reference required (sheetId or sheetName)')
		}

		const scopes = scopesForRequest(writeScopes, {
			sheetId: resolvedSheetId,
			sheetName: resolvedSheetName,
			defaultSheetId,
			defaultSheetName,
			sheetIdToName,
		})
		if (!scopes.length) {
			const requested = resolvedSheetName || resolvedSheetId || 'unknown'
			throw new Error(
				allowedWriteSheetsLabel
					? `[univer] write sheet not allowed (requested: ${requested}; allowed sheets: ${allowedWriteSheetsLabel})`
					: '[univer] write sheet not allowed',
			)
		}
	}

	const ctx: McpContext = {
		bridge,
		workbook: bridge.workbook ?? null,
		readScopes,
		writeScopes,
		sheetIdToName,
		sheetNameToId,
		defaultSheetId,
		defaultSheetName,
		viewLimits: {
			maxRows: Math.max(1, Math.floor(opts.viewLimits?.maxRows ?? 40)),
			maxCols: Math.max(1, Math.floor(opts.viewLimits?.maxCols ?? 16)),
		},
		limits,
		stats,
		cache,
		checkCanChange,
		checkCanApplyOps,
		bumpChange,
		checkReadRange,
		checkWriteRange,
		checkWriteCell,
		checkWriteSheet,
	}

	const selectedGroups = opts.groups && opts.groups.length ? opts.groups : UNIVER_LOOPBACK_TOOL_GROUPS
	const mcpTools = createMcpTools(ctx, selectedGroups)
	const mergedRaw = mcpTools
	let toolCallSeq = 0
	const nextSeq = () => {
		toolCallSeq += 1
		return toolCallSeq
	}
	const otelInstruments = createUniverAxOtelInstruments(opts.otel?.meter)
	const merged = mergedRaw.map((t) => wrapAxTool(t, { stats, nextSeq, otel: opts.otel, otelInstruments }))
	return {
		tools: merged,
		stats,
		helpers: {
			readRangeDisplay,
		},
	}
}
