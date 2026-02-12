import { chatInputToMessage } from '@douyinfe/semi-ui-19'
import type { Message as AiMessage } from '@douyinfe/semi-ui-19/lib/es/aiChatDialogue/interface'
import type { MessageContent } from '@douyinfe/semi-ui-19/lib/es/aiChatInput/interface'
import type { Reference as AiReference } from '@douyinfe/semi-ui-19/lib/es/aiChatInput/interface'
import { rpcErrorMessage } from '@pluxel/hmr/web'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { UniverAiContext, UniverLoopbackRunInput, UniverLoopbackRunResult } from '@pluxel/univer-headless/protocol'

import { rangeToA1 } from '../a1'
import { getSheetWholeA1, getWorkbookWholeA1List } from '../univer-bridge'
import {
	clearUniverAiSelections,
	pinUniverAiSelections,
	unpinUniverAiSelection,
	useUniverAiContextState,
} from '../context-store'
import {
	addUniverAiReadScopeFromSelections,
	limitUniverAiReadScopeToSelections,
	removeUniverAiReadScope,
	resetUniverAiReadScopeToWorkbook,
	resetUniverAiReadScopeToSheet,
	useUniverAiReadScopeState,
} from '../read-scope-store'
import {
	addUniverAiWriteScopeFromSelections,
	allowUniverAiWriteScopeToSheet,
	allowUniverAiWriteScopeToWorkbook,
	disableUniverAiWriteScope,
	limitUniverAiWriteScopeToSelections,
	removeUniverAiWriteScope,
	useUniverAiWriteScopeState,
} from '../write-scope-store'
import type { AiPanelProps } from './types'

const CONTEXT_STYLE = { stroke: '#a855f7', fill: 'rgba(168, 85, 247, 0.08)' } as const
const READ_STYLE = { stroke: '#3b82f6', fill: 'rgba(59, 130, 246, 0.08)' } as const
const WRITE_STYLE = { stroke: '#f97316', fill: 'rgba(249, 115, 22, 0.10)' } as const

export type AiPanelReference = Readonly<{
	type: string
	id: string
	label: string
	meta?: string
	closable?: boolean
}> & AiReference

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
			const rec = item as Record<string, unknown>
			if (typeof rec.text === 'string') return rec.text
			if (typeof rec.value === 'string') return rec.value
			return ''
		})
		.join('')
		.trim()
}

function selectionKey(ctx: UniverAiContext) {
	const range = ctx.selection.range
	const keyRange = range ? `${range.startRow}:${range.startCol}-${range.endRow}:${range.endCol}` : 'range:unknown'
	return `${ctx.workbookId}:${ctx.selection.sheetId ?? 'sheet'}:${keyRange}`
}

function selectionLabel(ctx: UniverAiContext) {
	const range = ctx.selection.range
	const a1 = ctx.selection.a1
	if (!range) return a1 ?? '未命名选区'
	const rows = range.endRow - range.startRow + 1
	const cols = range.endCol - range.startCol + 1
	const labelA1 = a1 ? ` ${a1}` : ''
	return `${rows}x${cols}${labelA1}`
}

function selectionMeta(ctx: UniverAiContext) {
	const truncated = ctx.selection.truncated
	return `${ctx.selection.sheetId ?? 'sheet'}${truncated ? ' · truncated' : ''}`
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

function selectionA1(ctx: UniverAiContext) {
	const a1 = ctx.selection.a1
	if (a1) return a1
	const range = ctx.selection.range
	return range ? rangeToA1(range) : ''
}

function selectionOrigA1(ctx: UniverAiContext) {
	const a1 = selectionA1(ctx)
	const sheetName = a1.includes('!') ? a1.split('!')[0] : ''
	const orig = ctx.selection.orig
	if (!orig) return a1
	const base = rangeToA1({ startRow: orig.startRow, startCol: orig.startCol, endRow: orig.endRow, endCol: orig.endCol })
	return sheetName ? `${sheetName}!${base}` : base
}

export function useAiPanelController(props: AiPanelProps) {
	const { workbookId, getRuntime } = props

	const [warn, setWarn] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const [chats, setChats] = useState<AiMessage[]>(props.dev?.chats ?? [])
	const [instruction, setInstruction] = useState(props.dev?.instruction ?? '')

	const storeState = useUniverAiContextState(workbookId)
	const [devPinnedState, setDevPinnedState] = useState<UniverAiContext[]>(props.dev?.pinnedSelections ?? [])
	const pinnedSelections = props.dev ? devPinnedState : storeState.pinnedSelections

	const readStoreState = useUniverAiReadScopeState(workbookId)
	const devReadScopeMode = props.dev?.readScopeMode ?? 'sheet'
	const devReadScopes = props.dev?.readScopes ?? []
	const readScopeMode = props.dev ? devReadScopeMode : readStoreState.mode

	const writeStoreState = useUniverAiWriteScopeState(workbookId)
	const devWriteScopeMode = props.dev?.writeScopeMode ?? 'none'
	const devWriteScopes = props.dev?.writeScopes ?? []
	const writeScopeMode = props.dev ? devWriteScopeMode : writeStoreState.mode

	const [activeSheetId, setActiveSheetId] = useState<string | null>(null)

	const appendChat = useCallback((m: AiMessage) => {
		setChats((prev) => prev.concat(m))
	}, [])

	const updateChat = useCallback((id: string, patch: Partial<AiMessage>) => {
		setChats((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)))
	}, [])

	const unpinSelection = useCallback((id: string) => {
		if (props.dev) {
			setDevPinnedState((prev) => prev.filter((s) => selectionKey(s) !== id))
			return
		}
		unpinUniverAiSelection(workbookId, id)
	}, [props.dev, workbookId])

	const clearPins = useCallback(() => {
		if (props.dev) {
			setDevPinnedState([])
			return
		}
		clearUniverAiSelections(workbookId)
	}, [props.dev, workbookId])

	const currentSheetWholeA1 = useMemo(() => {
		const rt = getRuntime()
		if (!rt) return null
		return getSheetWholeA1({ api: rt.api, sheetId: activeSheetId })
	}, [activeSheetId, getRuntime, props.runtimeSeq])

	const currentWorkbookWholeA1 = useMemo(() => {
		const rt = getRuntime()
		if (!rt) return []
		return getWorkbookWholeA1List({ api: rt.api, maxSheets: 64 })
	}, [getRuntime, props.runtimeSeq])

	useEffect(() => {
		const rt = getRuntime()
		if (!rt) return

		const getActiveId = () => {
			const wb: any = rt.api.getActiveWorkbook?.()
			const sh: any = wb?.getActiveSheet?.()
			const id = sh?.getSheetId?.()
			return id ? String(id) : null
		}

		setActiveSheetId(getActiveId())

		const eventKey = (rt.api as any)?.Event?.ActiveSheetChanged
		if (!eventKey) return
		const off = (rt.api as any).addEvent(eventKey, (params: any) => {
			const id = params?.activeSheet?.getSheetId?.()
			setActiveSheetId(id ? String(id) : getActiveId())
		})
		return () => {
			off?.dispose?.()
		}
	}, [getRuntime, props.runtimeSeq])

	useEffect(() => {
		const rt = getRuntime()
		if (!rt) return
		return () => {
			rt.clearOverlay()
		}
	}, [getRuntime, props.runtimeSeq])

		useEffect(() => {
			if (!props.ready) return
			const rt = getRuntime()
			if (!rt) return

			const items: Array<{ sheetId?: string | null; range: any; style?: unknown }> = []
			const activeId = activeSheetId
			for (const s of pinnedSelections) {
				if (!s.selection.range) continue
				if (activeId && s.selection.sheetId && String(s.selection.sheetId) !== activeId) continue
				items.push({ sheetId: s.selection.sheetId ?? null, range: s.selection.range, style: CONTEXT_STYLE })
			}

			if (readScopeMode === 'ranges' && !props.dev) {
				for (const it of readStoreState.items) {
					if (activeId && it.sheetId && String(it.sheetId) !== activeId) continue
					items.push({ sheetId: it.sheetId ?? null, range: it.range, style: READ_STYLE })
				}
			}

			if (writeScopeMode === 'ranges' && !props.dev) {
				for (const it of writeStoreState.items) {
					if (activeId && it.sheetId && String(it.sheetId) !== activeId) continue
					items.push({ sheetId: it.sheetId ?? null, range: it.range, style: WRITE_STYLE })
				}
			}

			rt.setOverlayHighlights({ items })
		}, [
			activeSheetId,
			getRuntime,
			pinnedSelections,
			props.dev,
			props.ready,
			props.runtimeSeq,
			readScopeMode,
			readStoreState.items,
			writeScopeMode,
			writeStoreState.items,
			workbookId,
		])

	const selectionReferences = useMemo(() => {
		const refs: AiPanelReference[] = []
		for (const s of pinnedSelections) {
			const id = selectionKey(s)
			refs.push({
				type: 'univer.selection',
				id,
				label: selectionLabel(s),
				meta: selectionMeta(s),
				closable: true,
			})
		}
		return refs
	}, [pinnedSelections])

	const effectiveWriteScopes = useMemo(() => {
		if (writeScopeMode === 'none') return []
		if (writeScopeMode === 'workbook') return uniqueA1(currentWorkbookWholeA1.map((s) => s.a1))
		if (writeScopeMode === 'sheet') {
			if (currentSheetWholeA1?.a1) return [currentSheetWholeA1.a1]
			return pinnedSelections[0] ? [selectionOrigA1(pinnedSelections[0])] : []
		}
		if (props.dev) return uniqueA1(devWriteScopes)
		return uniqueA1(writeStoreState.items.map((it) => it.a1))
	}, [currentSheetWholeA1, currentWorkbookWholeA1, devWriteScopes, pinnedSelections, props.dev, writeScopeMode, writeStoreState.items])

	const effectiveReadScopes = useMemo(() => {
		if (readScopeMode === 'workbook') return uniqueA1(currentWorkbookWholeA1.map((s) => s.a1))
		if (readScopeMode === 'sheet') {
			if (currentSheetWholeA1?.a1) return [currentSheetWholeA1.a1]
			return pinnedSelections[0] ? [selectionOrigA1(pinnedSelections[0])] : []
		}
		if (props.dev) return uniqueA1(devReadScopes)
		return uniqueA1(readStoreState.items.map((it) => it.a1))
	}, [currentSheetWholeA1, currentWorkbookWholeA1, devReadScopes, pinnedSelections, props.dev, readScopeMode, readStoreState.items])

	const removeWriteScope = useCallback((a1: string) => {
		if (props.dev) return
		removeUniverAiWriteScope(workbookId, a1)
	}, [props.dev, workbookId])

	const disableWrite = useCallback(() => {
		if (props.dev) return
		disableUniverAiWriteScope(workbookId)
	}, [props.dev, workbookId])

	const allowWriteSheet = useCallback(() => {
		if (props.dev) return
		allowUniverAiWriteScopeToSheet(workbookId)
	}, [props.dev, workbookId])

	const allowWriteWorkbook = useCallback(() => {
		if (props.dev) return
		allowUniverAiWriteScopeToWorkbook(workbookId)
	}, [props.dev, workbookId])

	const limitWriteToPinned = useCallback(() => {
		if (props.dev) return
		if (!pinnedSelections.length) return
		limitUniverAiWriteScopeToSelections(workbookId, pinnedSelections)
	}, [props.dev, pinnedSelections, workbookId])

	const addWriteFromPinned = useCallback(() => {
		if (props.dev) return
		if (!pinnedSelections.length) return
		addUniverAiWriteScopeFromSelections(workbookId, pinnedSelections)
	}, [props.dev, pinnedSelections, workbookId])

	const removeReadScope = useCallback((a1: string) => {
		if (props.dev) return
		removeUniverAiReadScope(workbookId, a1)
	}, [props.dev, workbookId])

	const resetReadToSheet = useCallback(() => {
		if (props.dev) return
		resetUniverAiReadScopeToSheet(workbookId)
	}, [props.dev, workbookId])

	const resetReadToWorkbook = useCallback(() => {
		if (props.dev) return
		resetUniverAiReadScopeToWorkbook(workbookId)
	}, [props.dev, workbookId])

	const limitReadToPinned = useCallback(() => {
		if (props.dev) return
		if (!pinnedSelections.length) return
		limitUniverAiReadScopeToSelections(workbookId, pinnedSelections)
	}, [props.dev, pinnedSelections, workbookId])

	const addReadFromPinned = useCallback(() => {
		if (props.dev) return
		if (!pinnedSelections.length) return
		addUniverAiReadScopeFromSelections(workbookId, pinnedSelections)
	}, [props.dev, pinnedSelections, workbookId])

	const ensureBackend = useCallback(() => {
		if (!props.backend) throw new Error('UniverLoopback 未启用')
		if (props.dirty) throw new Error('当前有未保存修改，请先保存/刷新快照后再运行 AI。')
		return props.backend
	}, [props.backend, props.dirty])

	const runLoopback = useCallback(
		async (text: string) => {
			setWarn(null)
			setError(null)

			let backend: NonNullable<AiPanelProps['backend']>
			try {
				backend = ensureBackend()
			} catch (e) {
				setWarn(e instanceof Error ? e.message : String(e))
				return
			}

			if (!pinnedSelections.length) {
				setWarn('未添加 AI 情境：仍可运行，但模型首轮缺少你指定的上下文预览。建议右键“AI → 添加到 AI 情境”。')
			}

			const readScopes = effectiveReadScopes.length ? effectiveReadScopes : (currentSheetWholeA1?.a1 ? [currentSheetWholeA1.a1] : [])
			if (!readScopes.length) {
				setWarn('无法获取读取范围（readScopes）。请切换到有效工作表后重试。')
				return
			}
			const current = currentSheetWholeA1?.a1 ?? readScopes[0]!
			const writeScopes = effectiveWriteScopes

			const assistantId = makeChatId()
			const scopeHint = `read: ${readScopes.length ? readScopes.join(', ') : 'none'}\nwrite: ${
				writeScopes.length ? writeScopes.join(', ') : 'none'
			}`
				appendChat({
					id: assistantId,
					role: 'assistant',
					content: `正在执行 loopback…\n可编辑范围: ${scopeHint}`,
					createdAt: Date.now(),
				})

			setBusy(true)
			try {
				const selectionContexts = pinnedSelections.filter((x): x is UniverAiContext => Boolean(x))
				const input: UniverLoopbackRunInput = {
					workbookId,
					instruction: text,
					scopes: { read: readScopes, ...(writeScopes.length ? { write: writeScopes } : {}), current },
					contexts: {
						selections: selectionContexts,
					},
				}
				const res = await backend.runLoopback(input)
				const line = formatResult(res)
				updateChat(assistantId, { content: line })
				if (res.ok && res.newRev !== res.baseRev) {
					props.onReloadLatest?.()
				}
			} catch (err) {
				updateChat(assistantId, { content: rpcErrorMessage(err, 'loopback 失败') })
			} finally {
				setBusy(false)
			}
		},
		[
			appendChat,
			currentSheetWholeA1,
			ensureBackend,
			effectiveReadScopes,
			effectiveWriteScopes,
			pinnedSelections,
			props.onReloadLatest,
			readScopeMode,
			updateChat,
			workbookId,
			writeScopeMode,
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
			void runLoopback(text)
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
			pinnedSelections,
			readScopeMode,
			readScopes: effectiveReadScopes,
			writeScopeMode,
			writeScopes: effectiveWriteScopes,
			activeSheetWholeA1: currentSheetWholeA1,
			resetReadToWorkbook,
			resetReadToSheet,
			limitReadToPinned,
			addReadFromPinned,
			removeReadScope,
			disableWrite,
			allowWriteWorkbook,
			allowWriteSheet,
			limitWriteToPinned,
			addWriteFromPinned,
			removeWriteScope,
			unpinSelection,
			clearPins,
			selectionReferences,
			editableScopes: effectiveWriteScopes,
			selectionKey,
			selectionLabel,
			selectionMeta,
			handleAiSend,
		}
	}

function formatResult(res: UniverLoopbackRunResult) {
	if (!res.ok) {
		if (res.conflict) {
			return `冲突：当前 rev=${res.conflict.currentRev}（请刷新后重试）\n${res.error}${res.runId ? `\nrunId=${res.runId}` : ''}`
		}
		return `失败：${res.error}${res.runId ? `\nrunId=${res.runId}` : ''}`
	}
	const changed = res.newRev !== res.baseRev
	const revLine = changed ? `已提交 rev ${res.baseRev} → ${res.newRev}` : `无变更（rev=${res.baseRev}）`
	return [
		revLine,
		`steps=${res.rounds} · ops=${res.appliedOps}`,
		res.runId ? `runId=${res.runId}` : null,
		res.summary ? `summary: ${res.summary}` : null,
	]
		.filter(Boolean)
		.join('\n')
}
