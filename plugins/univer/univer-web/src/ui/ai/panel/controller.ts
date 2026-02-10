import { chatInputToMessage } from '@douyinfe/semi-ui-19'
import type { Message as AiMessage } from '@douyinfe/semi-ui-19/lib/es/aiChatDialogue/interface'
import type { MessageContent } from '@douyinfe/semi-ui-19/lib/es/aiChatInput/interface'
import { rpcErrorMessage } from '@pluxel/hmr/web'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { UniverAiContext, UniverLoopbackRunInput, UniverLoopbackRunResult } from '@pluxel/univer-headless/protocol'

import { rangeToA1 } from '../a1'
import { collectActiveSelectionContexts } from '../univer-bridge'
import type { AiPanelProps } from './types'

const MAX_FILL_DOWN_ROWS = 200
const MAX_LOOP_ROUNDS = 10
const DEFAULT_LIMITS = { maxRows: 40, maxCols: 16 } as const

function clampInt(n: unknown, min: number, max: number) {
	const v = typeof n === 'number' && Number.isFinite(n) ? n : min
	return Math.max(min, Math.min(max, Math.floor(v)))
}

function makeChatId() {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function extractInstruction(payload: MessageContent | null) {
	const items = payload?.inputContents ?? []
	if (!items.length) return ''
	return items
		.map((item) => {
			if (!item || typeof item !== 'object') return ''
			const text = (item as any).text
			if (typeof text === 'string') return text
			const value = (item as any).value
			if (typeof value === 'string') return value
			return ''
		})
		.join('')
		.trim()
}

function selectionKey(ctx: UniverAiContext) {
	const range = ctx.range
	const keyRange = range ? `${range.startRow}:${range.startCol}-${range.endRow}:${range.endCol}` : 'range:unknown'
	return `${ctx.workbookId}:${ctx.sheetId ?? 'sheet'}:${keyRange}`
}

function selectionLabel(ctx: UniverAiContext) {
	const range = ctx.range
	if (!range) return ctx.a1 ?? '未命名选区'
	const rows = range.endRow - range.startRow + 1
	const cols = range.endCol - range.startCol + 1
	const a1 = ctx.a1 ? ` ${ctx.a1}` : ''
	return `${rows}x${cols}${a1}`
}

function selectionMeta(ctx: UniverAiContext) {
	const meta = ctx.meta as { truncated?: boolean } | undefined
	return `${ctx.sheetId ?? 'sheet'}${meta?.truncated ? ' · truncated' : ''}`
}

function uniqueA1(scopes: readonly string[]) {
	const out: string[] = []
	const seen = new Set<string>()
	for (const s of scopes) {
		const a1 = String(s ?? '').trim()
		if (!a1 || seen.has(a1)) continue
		seen.add(a1)
		out.push(a1)
	}
	return out
}

function fillDownA1(current: UniverAiContext, rows: number) {
	if (!current.range) return null
	if (!current.a1) return null
	const selRows = current.range.endRow - current.range.startRow + 1
	const maxExtra = Math.max(0, DEFAULT_LIMITS.maxRows - selRows)
	const n = clampInt(rows, 0, Math.min(MAX_FILL_DOWN_ROWS, maxExtra))
	if (n <= 0) return null

	const baseSheet = current.a1.includes('!') ? current.a1.split('!')[0]!.trim() : ''
	const extra = {
		startRow: current.range.endRow + 1,
		startCol: current.range.startCol,
		endRow: current.range.endRow + n,
		endCol: current.range.endCol,
	}
	const a1 = `${baseSheet ? `${baseSheet}!` : ''}${rangeToA1(extra)}`
	return a1
}

export function useAiPanelController(props: AiPanelProps) {
	const { workbookId, getRuntime } = props

	const [warn, setWarn] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const [chats, setChats] = useState<AiMessage[]>(props.dev?.chats ?? [])
	const [instruction, setInstruction] = useState(props.dev?.instruction ?? '')

	const [currentSelection, setCurrentSelection] = useState<UniverAiContext | null>(props.dev?.currentSelection ?? null)
	const [pinnedSelections, setPinnedSelections] = useState<UniverAiContext[]>(props.dev?.pinnedSelections ?? [])

	const [writeMode, setWriteMode] = useState<'scoped' | 'table'>(props.dev?.writeMode ?? 'scoped')
	const [fillDownRows, setFillDownRows] = useState<number>(props.dev?.fillDownRows ?? 0)
	const [loopMaxRounds, setLoopMaxRounds] = useState<number>(props.dev?.loopMaxRounds ?? 1)
	const [mode, setMode] = useState<'safe' | 'aggressive'>(props.dev?.mode ?? 'safe')

	const appendChat = useCallback((m: AiMessage) => {
		setChats((prev) => prev.concat(m))
	}, [])

	const updateChat = useCallback((id: string, patch: Partial<AiMessage>) => {
		setChats((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)))
	}, [])

	const pinnedKeySet = useMemo(() => new Set(pinnedSelections.map(selectionKey)), [pinnedSelections])

	const refreshSelection = useCallback(() => {
		const rt = getRuntime()
		if (!rt) return
		const res = collectActiveSelectionContexts({ rt, workbookId, limits: DEFAULT_LIMITS })
		if (!res?.current) {
			setCurrentSelection(null)
			return
		}
		setCurrentSelection(res.current)
	}, [getRuntime, workbookId])

	useEffect(() => {
		refreshSelection()
	}, [props.runtimeSeq, refreshSelection])

	const pinCurrentSelection = useCallback(() => {
		if (!currentSelection) return
		const key = selectionKey(currentSelection)
		if (pinnedKeySet.has(key)) return
		setPinnedSelections((prev) => prev.concat(currentSelection))
	}, [currentSelection, pinnedKeySet])

	const unpinSelection = useCallback((id: string) => {
		setPinnedSelections((prev) => prev.filter((s) => selectionKey(s) !== id))
	}, [])

	const clearPins = useCallback(() => setPinnedSelections([]), [])

	const selectionReferences = useMemo(() => {
		const refs: any[] = []
		if (currentSelection) {
			refs.push({
				id: selectionKey(currentSelection),
				label: selectionLabel(currentSelection),
				meta: selectionMeta(currentSelection),
				closable: false,
			})
		}
		for (const s of pinnedSelections) {
			const id = selectionKey(s)
			refs.push({
				id,
				label: selectionLabel(s),
				meta: selectionMeta(s),
				closable: true,
			})
		}
		return refs
	}, [currentSelection, pinnedSelections])

	const maxFillDownRows = useMemo(() => {
		const range = currentSelection?.range
		if (!range) return 0
		const selRows = range.endRow - range.startRow + 1
		return Math.max(0, DEFAULT_LIMITS.maxRows - selRows)
	}, [currentSelection])

	useEffect(() => {
		setFillDownRows((prev) => clampInt(prev, 0, Math.min(MAX_FILL_DOWN_ROWS, maxFillDownRows)))
	}, [maxFillDownRows])

	const ensureBackend = useCallback(() => {
		if (!props.backend) throw new Error('UniverLoopback 未启用')
		if (props.dirty) throw new Error('当前有未保存修改，请先保存/刷新快照后再运行 AI。')
		return props.backend
	}, [props.backend, props.dirty])

	const runLoopback = useCallback(
		async (text: string, userMessageId: string) => {
			setWarn(null)
			setError(null)

			let backend
			try {
				backend = ensureBackend()
			} catch (e) {
				setWarn(e instanceof Error ? e.message : String(e))
				return
			}

			const current = currentSelection?.a1 ?? (currentSelection?.range ? rangeToA1(currentSelection.range) : null)
			if (!current) {
				setWarn('请先在表格中选中一个区域。')
				return
			}

			const readScopes = uniqueA1([current, ...pinnedSelections.map((s) => s.a1 ?? '').filter(Boolean)])
			const writeScopes = (() => {
				if (writeMode === 'table') return readScopes
				const extra = currentSelection ? fillDownA1(currentSelection, fillDownRows) : null
				return uniqueA1([current, ...(extra ? [extra] : [])])
			})()

			const assistantId = makeChatId()
			appendChat({
				id: assistantId,
				role: 'assistant',
				content: `正在执行 loopback…\nREAD: ${readScopes.length} · WRITE: ${writeScopes.length} · rounds≤${loopMaxRounds}`,
				createdAt: Date.now(),
				status: 'loading' as any,
			} as AiMessage)

			setBusy(true)
			try {
				const input: UniverLoopbackRunInput = {
					workbookId,
					instruction: text,
					read: readScopes,
					write: writeScopes,
					current,
					maxRounds: clampInt(loopMaxRounds, 1, MAX_LOOP_ROUNDS),
					mode,
					limits: DEFAULT_LIMITS,
				}
				const res = await backend.runLoopback(input)
				const line = formatResult(res)
				updateChat(assistantId, { content: line, status: res.ok ? undefined : ('error' as any) })
				if (res.ok && res.newRev !== res.baseRev) {
					props.onReloadLatest?.()
				}
			} catch (err) {
				updateChat(assistantId, { content: rpcErrorMessage(err, 'loopback 失败'), status: 'error' as any })
			} finally {
				setBusy(false)
			}
		},
		[
			appendChat,
			currentSelection,
			ensureBackend,
			fillDownRows,
			loopMaxRounds,
			mode,
			pinnedSelections,
			props,
			updateChat,
			workbookId,
			writeMode,
		],
	)

	const handleAiSend = useCallback(
		(payload: MessageContent) => {
			const text = extractInstruction(payload)
			if (!text) return
			setInstruction(text)

			const converted = chatInputToMessage(payload)
			const userMessage: AiMessage = {
				id: makeChatId(),
				role: converted.role ?? 'user',
				content: converted.content ?? text,
				createdAt: Date.now(),
				references: converted.references,
				setup: converted.setup,
			}
			appendChat(userMessage)
			void runLoopback(text, userMessage.id)
		},
		[appendChat, runLoopback],
	)

	return {
		warn,
		error,
		busy,
		chats,
		instruction,
		setInstruction,
		currentSelection,
		pinnedSelections,
		writeMode,
		setWriteMode,
		fillDownRows,
		setFillDownRows,
		maxFillDownRows,
		loopMaxRounds,
		setLoopMaxRounds,
		mode,
		setMode,
		refreshSelection,
		pinCurrentSelection,
		unpinSelection,
		clearPins,
		selectionReferences,
		selectionKey,
		selectionLabel,
		selectionMeta,
		handleAiSend,
	}
}

function formatResult(res: UniverLoopbackRunResult) {
	if (!res.ok) {
		if (res.conflict) {
			return `冲突：当前 rev=${res.conflict.currentRev}（请刷新后重试）\n${res.error}`
		}
		return `失败：${res.error}`
	}
	const changed = res.newRev !== res.baseRev
	const revLine = changed ? `已提交 rev ${res.baseRev} → ${res.newRev}` : `无变更（rev=${res.baseRev}）`
	return [revLine, `rounds=${res.rounds} · ops=${res.appliedOps}`, res.summary ? `summary: ${res.summary}` : null].filter(Boolean).join('\n')
}
