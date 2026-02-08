import { chatInputToMessage } from '@douyinfe/semi-ui-19'
import type { Message as AiMessage } from '@douyinfe/semi-ui-19/lib/es/aiChatDialogue/interface'
import type { MessageContent } from '@douyinfe/semi-ui-19/lib/es/aiChatInput/interface'
import { rpcErrorMessage } from '@pluxel/hmr/web'
import { formatStructured } from '@pluxel/promptkit/toon'
import type { ICellCustomRender, IDisposable } from '@univerjs/core'
import { IEditorBridgeService } from '@univerjs/sheets-ui'
import { create } from 'mutative'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
	UniverAiChange,
	UniverAiChangeSet,
	UniverAiContext,
	UniverAiSuggestEditsResult,
} from 'pluxel-plugin-univer-ai'

import type { UniverAiDecision, UniverAiFrontendApi, UniverAiSuggestInput } from '../ai-contract'
import { cellToA1, rangeToA1 } from '../a1'
import { cellKey, computePreparedChange, type PreparedAiChange } from '../changes'
import { buildToonContext } from '../toon'
import { collectActiveSelectionContexts, subscribeHoverCell } from '../univer-bridge'
import type { AiPanelProps, ChangeState } from './types'
import { AI_HOVER_CELL_POPUP_KEY, HoverCellPopup, type HoverCellPopupPayload } from './hover-cell-popup'

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

function makeChatId() {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return crypto.randomUUID()
	}
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`
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

function indexHoverCells(
	prepared: PreparedAiChange[],
	changeState: Record<string, ChangeState>,
	appliedCells: Record<string, Record<string, boolean>>,
	ignoredCells: Record<string, Record<string, boolean>>,
) {
	const map = new Map<
		string,
		{
			changeId: string
			state: HoverCellPopupPayload['state']
			reason: string | null
			oldValue: string
			nextValue: string
		}
	>()

	for (const ch of prepared) {
		const state = changeState[ch.id] ?? 'idle'
		if (state === 'rejected') continue
		const appliedByCell = appliedCells[ch.id] ?? {}
		if (state === 'idle') {
			let hasApplied = false
			for (const _k in appliedByCell) {
				hasApplied = true
				break
			}
			if (!hasApplied) continue
		}
		const ignoredByCell = ignoredCells[ch.id] ?? {}
		const sheetId = ch.sheetId
		if (!sheetId) continue
		for (const diff of ch.cellDiffs) {
			if (ignoredByCell[`${diff.row}:${diff.col}`]) continue
			const isApplied = Boolean(appliedByCell[`${diff.row}:${diff.col}`])
			if (state === 'idle' && !isApplied) continue
			const hoverState: HoverCellPopupPayload['state'] =
				isApplied ? 'applied' : state === 'preview' ? 'preview' : 'suggested'
			map.set(cellKey(sheetId, diff.row, diff.col), {
				changeId: ch.id,
				state: hoverState,
				reason: ch.reason,
				oldValue: diff.oldValue,
				nextValue: diff.nextValue,
			})
		}
	}

	return map
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
	if (maxWidth <= 0) return ''
	if (ctx.measureText(text).width <= maxWidth) return text
	const ellipsis = '…'
	let lo = 0
	let hi = text.length
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2)
		const candidate = text.slice(0, mid) + ellipsis
		if (ctx.measureText(candidate).width <= maxWidth) lo = mid
		else hi = mid - 1
	}
	return text.slice(0, Math.max(0, lo)) + ellipsis
}

function yieldToBrowser() {
	return new Promise<void>((resolve) => {
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
		else setTimeout(resolve, 0)
	})
}

type CellWriteOp = {
	row: number
	startCol: number
	endCol: number
	kind: 'set' | 'clear'
	values?: string[]
}

function buildRowWriteOps(diffs: PreparedAiChange['cellDiffs'], valueFor: (diff: PreparedAiChange['cellDiffs'][number]) => string) {
	const byRow = new Map<number, PreparedAiChange['cellDiffs']>()
	for (const d of diffs) {
		const list = byRow.get(d.row) ?? []
		list.push(d)
		byRow.set(d.row, list)
	}

	const ops: CellWriteOp[] = []
	const sortedRows = Array.from(byRow.keys()).sort((a, b) => a - b)
	for (const row of sortedRows) {
		const rowDiffs = (byRow.get(row) ?? []).slice().sort((a, b) => a.col - b.col)
		if (!rowDiffs.length) continue

		let startCol = rowDiffs[0]!.col
		let prevCol = rowDiffs[0]!.col
		let firstValue = valueFor(rowDiffs[0]!)
		let kind: CellWriteOp['kind'] = firstValue === '' ? 'clear' : 'set'
		let values: string[] = kind === 'set' ? [firstValue] : []

		for (let i = 1; i < rowDiffs.length; i++) {
			const d = rowDiffs[i]!
			const col = d.col
			const value = valueFor(d)
			const nextKind: CellWriteOp['kind'] = value === '' ? 'clear' : 'set'
			const contiguous = col === prevCol + 1

			if (contiguous && nextKind === kind) {
				if (kind === 'set') values.push(value)
				prevCol = col
				continue
			}

			ops.push({
				row,
				startCol,
				endCol: prevCol,
				kind,
				values: kind === 'set' ? values : undefined,
			})

			startCol = col
			prevCol = col
			kind = nextKind
			values = kind === 'set' ? [value] : []
		}

		ops.push({
			row,
			startCol,
			endCol: prevCol,
			kind,
			values: kind === 'set' ? values : undefined,
		})
	}

	return ops
}

async function applyWriteOps(sheet: any, ops: CellWriteOp[], opts?: { yieldEvery?: number }) {
	const yieldEvery = typeof opts?.yieldEvery === 'number' && Number.isFinite(opts.yieldEvery) ? Math.max(1, Math.floor(opts.yieldEvery)) : 24
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i]!
		const range = sheet.getRange({
			startRow: op.row,
			startColumn: op.startCol,
			endRow: op.row,
			endColumn: op.endCol,
		})
		if (op.kind === 'clear') {
			range.clearContent()
		} else {
			range.setValues([op.values ?? []] as any)
		}

		if ((i + 1) % yieldEvery === 0) {
			await yieldToBrowser()
		}
	}
}

type BusyOp =
	| { kind: 'preview'; changeId: string }
	| { kind: 'apply'; changeId: string }
	| { kind: 'undo'; changeId: string }
	| { kind: 'reject'; changeId: string }
	| { kind: 'applySelected'; changeId: string }
	| { kind: 'undoSelected'; changeId: string }
	| { kind: 'applyAll'; done: number; total: number }
	| { kind: 'undoAll'; done: number; total: number }

function locateChange(rt: { highlightRange?: (input: any) => void }, ch: PreparedAiChange, mode: 'preview' | 'applied') {
	const fill = mode === 'applied' ? 'rgba(34, 197, 94, 0.16)' : 'rgba(245, 158, 11, 0.16)'
	const stroke = mode === 'applied' ? '#16a34a' : '#f59e0b'
	try {
		rt.highlightRange?.({
			sheetId: ch.sheetId,
			range: ch.range,
			style: {
				id: `ai-locate-${mode}-${ch.id}-${Date.now()}`,
				fill,
				stroke,
				strokeWidth: 3,
				rowHeaderFill: fill,
				columnHeaderFill: fill,
			},
			durationMs: 900,
		})
	} catch {
		// best-effort
	}
}

function highlightSegmentsForChange(
	rt: { api: any },
	ch: PreparedAiChange,
	mode: 'preview' | 'applied',
	cellDiffs?: PreparedAiChange['cellDiffs'],
) {
	const workbook = rt.api.getActiveWorkbook()
	if (!workbook) return []
	const sheet = ch.sheetId ? workbook.getSheetBySheetId(ch.sheetId) : workbook.getActiveSheet()
	if (!sheet) return []

	const fill = mode === 'applied' ? 'rgba(34, 197, 94, 0.26)' : 'rgba(245, 158, 11, 0.26)'
	const stroke = mode === 'applied' ? '#16a34a' : '#f59e0b'
	const maxSegments = 220

	const diffs = cellDiffs ?? ch.cellDiffs
	if (diffs.length === 0) return []

	const byRow = new Map<number, number[]>()
	for (const d of diffs) {
		const cols = byRow.get(d.row) ?? []
		cols.push(d.col)
		byRow.set(d.row, cols)
	}

	const disposables: IDisposable[] = []
	let segCount = 0
	for (const [row, colsRaw] of byRow.entries()) {
		const cols = Array.from(new Set(colsRaw)).sort((a, b) => a - b)
		let start = cols[0]!
		let prev = cols[0]!
		for (let i = 1; i <= cols.length; i++) {
			const col = cols[i]
			const isBreak = i === cols.length || col !== prev + 1
			if (isBreak) {
				const range = sheet.getRange({
					startRow: row,
					startColumn: start,
					endRow: row,
					endColumn: prev,
				})
				const disposable = range.highlight({
					id: `ai-${mode}-${ch.id}-${row}-${start}-${prev}`,
					fill,
					stroke,
					strokeWidth: 2,
					rowHeaderFill: fill,
					columnHeaderFill: fill,
				})
				disposables.push(disposable)
				segCount++
				if (segCount >= maxSegments) return disposables
				start = col ?? start
			}
			prev = col ?? prev
		}
	}

	return disposables
}

async function setChangeValues(rt: { api: any }, ch: PreparedAiChange) {
	const workbook = rt.api.getActiveWorkbook()
	if (!workbook) return
	const sheet = ch.sheetId ? workbook.getSheetBySheetId(ch.sheetId) : workbook.getActiveSheet()
	if (!sheet) return
	const range = sheet.getRange({
		startRow: ch.range.startRow,
		startColumn: ch.range.startCol,
		endRow: ch.range.endRow,
		endColumn: ch.range.endCol,
	})
	if (ch.op === 'clear') {
		range.clearContent()
		return
	}
	range.setValues((ch.nextMatrix ?? ch.oldMatrix) as any)
}

async function restoreChangeOldValues(rt: { api: any }, ch: PreparedAiChange) {
	const workbook = rt.api.getActiveWorkbook()
	if (!workbook) return
	const sheet = ch.sheetId ? workbook.getSheetBySheetId(ch.sheetId) : workbook.getActiveSheet()
	if (!sheet) return
	const range = sheet.getRange({
		startRow: ch.range.startRow,
		startColumn: ch.range.startCol,
		endRow: ch.range.endRow,
		endColumn: ch.range.endCol,
	})
	range.setValues(ch.oldMatrix as any)
}

export function useAiPanelController(props: AiPanelProps) {
	const { ready, workbookId, getRuntime, api, dev, runtimeSeq } = props
	const runtimeKey = runtimeSeq ?? 0

	const [tab, setTab] = useState<'chat' | 'changes' | 'debug'>('chat')
	const [instruction, setInstruction] = useState(
		dev?.instruction ?? '把选区里的数据整理成一张干净的表，并补全缺失字段。',
	)
	const [chats, setChats] = useState<AiMessage[]>(dev?.chats ?? [])
	const [loading, setLoading] = useState(false)
	const [busyOp, setBusyOp] = useState<BusyOp | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [warn, setWarn] = useState<string | null>(null)

	const [autoSync, setAutoSync] = useState(dev?.autoSync ?? true)
	const [currentSelection, setCurrentSelection] = useState<UniverAiContext | null>(dev?.currentSelection ?? null)
	const [pinnedSelections, setPinnedSelections] = useState<UniverAiContext[]>(dev?.pinnedSelections ?? [])
	const [implicitSelections, setImplicitSelections] = useState<UniverAiContext[]>([])

	const [changeSet, setChangeSet] = useState<UniverAiChangeSet | null>(dev?.changeSet ?? null)
	const [meta, setMeta] = useState<UniverAiSuggestEditsResult['meta'] | null>(dev?.meta ?? null)
	const [preparedChanges, setPreparedChanges] = useState<PreparedAiChange[]>([])
	const [activeChangeId, setActiveChangeId] = useState<string | null>(null)
	const [changeState, setChangeState] = useState<Record<string, ChangeState>>({})
	const [selectedCellsByChange, setSelectedCellsByChange] = useState<Record<string, Record<string, boolean>>>({})
	const [appliedCellsByChange, setAppliedCellsByChange] = useState<Record<string, Record<string, boolean>>>({})
	const [ignoredCellsByChange, setIgnoredCellsByChange] = useState<Record<string, Record<string, boolean>>>({})

	const [previewMode, setPreviewMode] = useState<'overlay' | 'inSheet'>(dev?.previewMode ?? 'overlay')
	const [hoverPopup, setHoverPopup] = useState(dev?.hoverPopup ?? true)
	const [virtualRender, setVirtualRender] = useState(true)

	const busy = loading || busyOp !== null

	const hoverIndexRef = useRef<ReturnType<typeof indexHoverCells>>(new Map())
	const hoverLastKeyRef = useRef<string | null>(null)
	const hoverPopupRef = useRef<IDisposable | null>(null)
	const hoverActionsRef = useRef<{
		apply?: (input: { changeId: string; sheetId: string; row: number; col: number }) => void
		undo?: (input: { changeId: string; sheetId: string; row: number; col: number }) => void
		ignore?: (input: { sheetId: string; row: number; col: number }) => void
	}>({})

	const decorationsRef = useRef<Map<string, IDisposable[]>>(new Map())
	const virtualEnabledRef = useRef(false)
	const virtualIndexRef = useRef<Map<string, { nextValue: string }>>(new Map())
	const editorBridgeRef = useRef<any>(null)
	const preparedChangesRef = useRef<PreparedAiChange[]>([])
	const lastLocateSigRef = useRef<string | null>(null)
	const busyOpRef = useRef<BusyOp | null>(null)

	const clearDecorations = useCallback((changeId: string) => {
		const existing = decorationsRef.current.get(changeId)
		if (!existing) return
		for (const d of existing) d.dispose()
		decorationsRef.current.delete(changeId)
	}, [])

	const clearAllDecorations = useCallback(() => {
		for (const items of decorationsRef.current.values()) {
			for (const d of items) d.dispose()
		}
		decorationsRef.current.clear()
	}, [])

	const clearHoverPopup = useCallback(() => {
		hoverPopupRef.current?.dispose()
		hoverPopupRef.current = null
		hoverLastKeyRef.current = null
	}, [])

	const runBusy = useCallback(
		async (op: BusyOp, fn: () => Promise<void>) => {
			if (loading || busyOpRef.current) return
			busyOpRef.current = op
			setBusyOp(op)
			clearHoverPopup()
			await yieldToBrowser()
			try {
				await fn()
			} finally {
				busyOpRef.current = null
				setBusyOp(null)
			}
		},
		[clearHoverPopup, loading],
	)

	useEffect(() => {
		// When the Univer runtime is recreated by the host (e.g. toggling plugins),
		// clear any UI artifacts that are bound to the previous instance.
		clearAllDecorations()
		clearHoverPopup()
		hoverIndexRef.current = new Map()
		hoverLastKeyRef.current = null
		virtualEnabledRef.current = false
		virtualIndexRef.current = new Map()
		editorBridgeRef.current = null
		lastLocateSigRef.current = null
		busyOpRef.current = null
		setBusyOp(null)
	}, [clearAllDecorations, clearHoverPopup, runtimeKey])

	const reportDecision = useCallback(
		(input: UniverAiDecision) => {
			api?.reportDecision?.(input)
		},
		[api],
	)

	const ensureApi = useCallback(() => {
		if (!api) {
			setError('UniverAI RPC 未启用：请在 profile 中启用 `pluxel-plugin-univer-ai`。')
			return null
		}
		return api
	}, [api])

	const refreshSelection = useCallback(() => {
		const rt = getRuntime()
		if (!rt) return
		const res = collectActiveSelectionContexts({ rt, workbookId })
		setCurrentSelection(res?.current ?? null)
		setImplicitSelections(res?.selections ?? [])
	}, [getRuntime, workbookId])

	const forceRepaint = useCallback(() => {
		const rt = getRuntime()
		if (!rt) return
		const workbook = rt.api.getActiveWorkbook()
		const sheet = workbook?.getActiveSheet()
		if (!sheet) return
		try {
			const flash = sheet
				.getRange({ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 })
				.highlight({ id: `ai-repaint-${Date.now()}`, stroke: 'rgba(0,0,0,0)', fill: 'rgba(0,0,0,0)', strokeWidth: 0 })
			queueMicrotask(() => flash.dispose())
		} catch {
			// best-effort
		}
	}, [getRuntime])

	useEffect(() => {
		if (!ready || !autoSync) return
		const rt = getRuntime()
		if (!rt) return

		refreshSelection()
		const eventName = (rt.api as any).Event?.SelectionChanged
		if (eventName) {
			const disposable = rt.api.addEvent(eventName, () => refreshSelection())
			return () => disposable.dispose()
		}

		const timer = window.setInterval(refreshSelection, 800)
		return () => window.clearInterval(timer)
	}, [autoSync, getRuntime, ready, refreshSelection, runtimeKey])

	useEffect(() => {
		const rt = getRuntime()
		if (!rt) return
		const disposable = rt.api.registerComponent(AI_HOVER_CELL_POPUP_KEY, HoverCellPopup)
		return () => disposable.dispose()
	}, [getRuntime, runtimeKey])

	useEffect(() => {
		preparedChangesRef.current = preparedChanges
	}, [preparedChanges])

	useEffect(() => {
		busyOpRef.current = busyOp
	}, [busyOp])

	useEffect(() => {
		const rt = getRuntime()
		if (!rt) return

		const injector = (rt.univer as any).__getInjector?.()
		editorBridgeRef.current = injector?.get?.(IEditorBridgeService) ?? null

		const render: ICellCustomRender = {
			drawWith: (ctx, info) => {
				if (!virtualEnabledRef.current) return
				const sheetId = String((info as any).subUnitId ?? '')
				if (!sheetId) return
				const key = cellKey(sheetId, info.row, info.col)
				const payload = virtualIndexRef.current.get(key)
				if (!payload) return

				const editorBridge = editorBridgeRef.current
				try {
					if (editorBridge?.isVisible?.().visible) {
						const loc = editorBridge.getEditLocation?.()
						if (loc && loc.row === info.row && loc.column === info.col) return
					}
				} catch {}

				const { startX, startY, endX, endY } = info.primaryWithCoord
				const width = endX - startX
				const height = endY - startY
				if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 2 || height <= 2) return

				const padX = 6
				const text = payload.nextValue === '' ? '∅' : payload.nextValue

				ctx.save()
				ctx.beginPath()
				ctx.rect(startX + 1, startY + 1, Math.max(0, width - 2), Math.max(0, height - 2))
				ctx.clip()

				const inset = 1
				const innerW = Math.max(0, width - inset * 2)
				const innerH = Math.max(0, height - inset * 2)

				ctx.fillStyle = 'rgba(255, 237, 213, 0.92)'
				ctx.fillRect(startX + inset, startY + inset, innerW, innerH)

				ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)'
				ctx.lineWidth = 2
				ctx.strokeRect(startX + inset + 1, startY + inset + 1, Math.max(0, innerW - 2), Math.max(0, innerH - 2))

				if (innerW >= 18 && innerH >= 18) {
					const tri = 10
					ctx.beginPath()
					ctx.moveTo(endX - inset, startY + inset)
					ctx.lineTo(endX - inset, startY + inset + tri)
					ctx.lineTo(endX - inset - tri, startY + inset)
					ctx.closePath()
					ctx.fillStyle = '#f59e0b'
					ctx.fill()
				}

				ctx.font = '12px "IBM Plex Sans", system-ui, -apple-system, Segoe UI, sans-serif'
				ctx.fillStyle = '#0f172a'
				ctx.textBaseline = 'middle'
				ctx.textAlign = 'left'

				const maxTextWidth = Math.max(0, width - padX * 2)
				const clipped = truncateText(ctx, text, maxTextWidth)
				ctx.fillText(clipped, startX + padX, startY + height / 2)

				ctx.restore()
			},
			zIndex: 30,
		}

		const hooks = (rt.api as any).getSheetHooks?.()
		if (!hooks?.onCellRender) return
		const disposable = hooks.onCellRender([render], undefined, 20) as IDisposable
		return () => disposable.dispose()
	}, [getRuntime, runtimeKey])

	useEffect(() => {
		hoverIndexRef.current = indexHoverCells(preparedChanges, changeState, appliedCellsByChange, ignoredCellsByChange)
	}, [appliedCellsByChange, changeState, ignoredCellsByChange, preparedChanges])

	const handleHoverCell = useCallback(
		(cell: { sheetId: string; row: number; col: number } | null) => {
			const rt = getRuntime()
			if (!rt || !cell) {
				clearHoverPopup()
				return
			}
			const key = cellKey(cell.sheetId, cell.row, cell.col)
			if (hoverLastKeyRef.current === key) return

			const entry = hoverIndexRef.current.get(key)
			if (!entry) {
				clearHoverPopup()
				return
			}

			hoverLastKeyRef.current = key
			hoverPopupRef.current?.dispose()
			hoverPopupRef.current = null

			const workbook = rt.api.getActiveWorkbook()
			if (!workbook) return
			const sheet = workbook.getSheetBySheetId(cell.sheetId)
			if (!sheet) return
			const range = sheet.getRange({
				startRow: cell.row,
				startColumn: cell.col,
				endRow: cell.row,
				endColumn: cell.col,
			})

			hoverPopupRef.current =
				range.attachPopup({
					componentKey: AI_HOVER_CELL_POPUP_KEY,
					direction: 'top',
					mask: false,
					extraProps: {
						title: cellToA1(cell.row, cell.col),
						state: entry.state,
						oldValue: entry.oldValue,
						nextValue: entry.nextValue,
						reason: entry.reason,
						actions: {
							apply:
								entry.state === 'applied'
									? undefined
									: {
											disabled: !ready || busy,
											onClick: () => {
												hoverActionsRef.current.apply?.({
													changeId: entry.changeId,
													sheetId: cell.sheetId,
													row: cell.row,
													col: cell.col,
												})
											},
										},
							undo:
								entry.state !== 'applied'
									? undefined
									: {
											disabled: !ready || busy,
											onClick: () => {
												hoverActionsRef.current.undo?.({
													changeId: entry.changeId,
													sheetId: cell.sheetId,
													row: cell.row,
													col: cell.col,
												})
											},
										},
							ignore: {
								disabled: !ready || busy,
								onClick: () => {
									hoverActionsRef.current.ignore?.({ sheetId: cell.sheetId, row: cell.row, col: cell.col })
									clearHoverPopup()
								},
							},
						},
					} satisfies HoverCellPopupPayload,
				}) ?? null
		},
		[busy, clearHoverPopup, getRuntime, ready],
	)

	useEffect(() => {
		if (!hoverPopup) {
			clearHoverPopup()
			return
		}
		const rt = getRuntime()
		if (!rt) return
		const sub = subscribeHoverCell(rt, handleHoverCell)
		return () => {
			sub.dispose()
			clearHoverPopup()
		}
	}, [clearHoverPopup, getRuntime, handleHoverCell, hoverPopup, runtimeKey])

	const markCellIgnored = useCallback((input: { sheetId: string; row: number; col: number }) => {
		const key = `${input.row}:${input.col}`
		const impacted = preparedChangesRef.current.filter(
			(ch) => ch.sheetId === input.sheetId && ch.cellDiffs.some((d) => d.row === input.row && d.col === input.col),
		)
		if (!impacted.length) return

		setIgnoredCellsByChange((prev) =>
			create(prev, (draft) => {
				for (const ch of impacted) {
					;(draft[ch.id] ??= {})[key] = true
				}
			}),
		)

		setSelectedCellsByChange((prev) =>
			create(prev, (draft) => {
				for (const ch of impacted) {
					;(draft[ch.id] ??= {})[key] = false
				}
			}),
		)

		setAppliedCellsByChange((prev) =>
			create(prev, (draft) => {
				for (const ch of impacted) {
					const applied = draft[ch.id]
					if (!applied) continue
					delete applied[key]
				}
			}),
		)
	}, [])

	useEffect(() => {
		const rt = getRuntime()
		if (!rt) return
		const eventName = (rt.api as any).Event?.SheetEditEnded
		if (!eventName) return
		const disposable = rt.api.addEvent(eventName, (ev: any) => {
			const row = Number(ev?.row)
			const col = Number(ev?.column)
			if (!Number.isFinite(row) || !Number.isFinite(col)) return
			const sheetId = String(ev?.worksheet?.getSheetId?.() ?? ev?.worksheet?.getId?.() ?? '')
			if (!sheetId) return
			markCellIgnored({ sheetId, row, col })
		})
		return () => {
			disposable.dispose()
		}
	}, [getRuntime, markCellIgnored, runtimeKey])

	const refreshDecorationsFor = useCallback(
		(changeId: string, next: { state?: ChangeState; applied?: Record<string, boolean> } = {}) => {
			const rt = getRuntime()
			if (!rt) return
			const ch = preparedChanges.find((c) => c.id === changeId)
			if (!ch) return

			const state = next.state ?? (changeState[changeId] ?? 'idle')
			const appliedByCell = next.applied ?? (appliedCellsByChange[changeId] ?? {})
			const ignoredByCell = ignoredCellsByChange[changeId] ?? {}

			clearDecorations(changeId)
			if (state === 'rejected') return

			const diffs = ch.cellDiffs.filter((d) => !ignoredByCell[`${d.row}:${d.col}`])
			const appliedDiffs = diffs.filter((d) => Boolean(appliedByCell[`${d.row}:${d.col}`]))
			const pendingDiffs = diffs.filter((d) => !appliedByCell[`${d.row}:${d.col}`])

			const segments: IDisposable[] = []
			if (pendingDiffs.length && state !== 'idle') {
				segments.push(...highlightSegmentsForChange(rt, ch, 'preview', pendingDiffs))
			}
			if (appliedDiffs.length) {
				segments.push(...highlightSegmentsForChange(rt, ch, 'applied', appliedDiffs))
			}
			if (segments.length) {
				decorationsRef.current.set(changeId, segments)
			}
		},
		[
			appliedCellsByChange,
			changeState,
			clearDecorations,
			getRuntime,
			ignoredCellsByChange,
			preparedChanges,
		],
	)

	const applyHoverCell = useCallback(
		async (input: { changeId: string; sheetId: string; row: number; col: number }) => {
			const rt = getRuntime()
			if (!rt) return
			const ch = preparedChangesRef.current.find((c) => c.id === input.changeId)
			if (!ch) return

			const cellKey = `${input.row}:${input.col}`
			const ignored = ignoredCellsByChange[input.changeId] ?? {}
			const applied = appliedCellsByChange[input.changeId] ?? {}
			if (ignored[cellKey] || applied[cellKey]) return

			const diff = ch.cellDiffs.find((d) => d.row === input.row && d.col === input.col)
			if (!diff) return

			await rt.withUndoBatch(async () => {
				const workbook = rt.api.getActiveWorkbook()
				if (!workbook) return
				const sheet = workbook.getSheetBySheetId(input.sheetId)
				if (!sheet) return
				const ops = buildRowWriteOps([diff], (d) => (ch.op === 'clear' ? '' : d.nextValue))
				await applyWriteOps(sheet, ops, { yieldEvery: 999 })
			})

			const nextApplied = { ...applied, [cellKey]: true }
			setAppliedCellsByChange((prev) =>
				create(prev, (draft) => {
					;(draft[input.changeId] ??= {})[cellKey] = true
				}),
			)

			const state = changeState[input.changeId] ?? 'preview'
			const nextState: ChangeState = state === 'idle' ? 'preview' : state
			if (nextState !== state) setChangeState((prev) => ({ ...prev, [input.changeId]: nextState }))
			refreshDecorationsFor(input.changeId, { state: nextState, applied: nextApplied })
			clearHoverPopup()
			reportDecision({
				workbookId,
				changeId: input.changeId,
				action: 'apply',
				op: ch.op,
				range: ch.range,
				sheetId: ch.sheetId,
				reason: ch.reason,
			})
		},
		[
			appliedCellsByChange,
			changeState,
			clearHoverPopup,
			getRuntime,
			ignoredCellsByChange,
			refreshDecorationsFor,
			reportDecision,
			workbookId,
		],
	)

	const undoHoverCell = useCallback(
		async (input: { changeId: string; sheetId: string; row: number; col: number }) => {
			const rt = getRuntime()
			if (!rt) return
			const ch = preparedChangesRef.current.find((c) => c.id === input.changeId)
			if (!ch) return

			const cellKey = `${input.row}:${input.col}`
			const applied = appliedCellsByChange[input.changeId] ?? {}
			if (!applied[cellKey]) return

			const diff = ch.cellDiffs.find((d) => d.row === input.row && d.col === input.col)
			if (!diff) return

			await rt.withUndoBatch(async () => {
				const workbook = rt.api.getActiveWorkbook()
				if (!workbook) return
				const sheet = workbook.getSheetBySheetId(input.sheetId)
				if (!sheet) return
				const ops = buildRowWriteOps([diff], (d) => d.oldValue)
				await applyWriteOps(sheet, ops, { yieldEvery: 999 })
			})

			const nextApplied = { ...applied }
			delete nextApplied[cellKey]
			setAppliedCellsByChange((prev) =>
				create(prev, (draft) => {
					const map = draft[input.changeId]
					if (!map) return
					delete map[cellKey]
				}),
			)

			const baseState = changeState[input.changeId] ?? 'preview'
			const nextState: ChangeState = Object.keys(nextApplied).length > 0 ? baseState : baseState === 'applied' ? 'preview' : baseState
			if (nextState !== baseState) setChangeState((prev) => ({ ...prev, [input.changeId]: nextState }))
			refreshDecorationsFor(input.changeId, { state: nextState, applied: nextApplied })
			clearHoverPopup()
			reportDecision({
				workbookId,
				changeId: input.changeId,
				action: 'undo',
				op: ch.op,
				range: ch.range,
				sheetId: ch.sheetId,
				reason: ch.reason,
			})
		},
		[
			appliedCellsByChange,
			changeState,
			clearHoverPopup,
			getRuntime,
			refreshDecorationsFor,
			reportDecision,
			workbookId,
		],
	)

	useEffect(() => {
		hoverActionsRef.current.apply = (input) => void applyHoverCell(input)
		hoverActionsRef.current.undo = (input) => void undoHoverCell(input)
		hoverActionsRef.current.ignore = (input) => markCellIgnored(input)
	}, [applyHoverCell, markCellIgnored, undoHoverCell])

	useEffect(() => {
		const enabled = previewMode === 'overlay' && virtualRender
		virtualEnabledRef.current = enabled
		if (!enabled) {
			virtualIndexRef.current = new Map()
			forceRepaint()
			return
		}

		const map = new Map<string, { nextValue: string }>()
		for (const ch of preparedChanges) {
			if (!ch.sheetId) continue
			const state = changeState[ch.id] ?? 'idle'
			if (state === 'rejected' || state === 'idle') continue
			const applied = appliedCellsByChange[ch.id] ?? {}
			const ignored = ignoredCellsByChange[ch.id] ?? {}
			for (const d of ch.cellDiffs) {
				if (ignored[`${d.row}:${d.col}`]) continue
				if (applied[`${d.row}:${d.col}`]) continue
				map.set(cellKey(ch.sheetId, d.row, d.col), { nextValue: d.nextValue })
			}
		}
		virtualIndexRef.current = map
		forceRepaint()
	}, [
		appliedCellsByChange,
		changeState,
		forceRepaint,
		ignoredCellsByChange,
		preparedChanges,
		previewMode,
		virtualRender,
	])

	useEffect(() => {
		if (previewMode !== 'overlay') return
		for (const id of decorationsRef.current.keys()) {
			refreshDecorationsFor(id)
		}
	}, [ignoredCellsByChange, previewMode, refreshDecorationsFor])

	const pinCurrentSelection = useCallback(() => {
		setWarn(null)
		const rt = getRuntime()
		if (!rt) return
		const res = collectActiveSelectionContexts({ rt, workbookId })
		const ctx = res?.current ?? null
		if (!ctx) {
			setWarn('无法获取选区：请先在表格里选中一个区域。')
			return
		}
		setCurrentSelection(ctx)
		const id = selectionKey(ctx)
		setPinnedSelections((prev) => (prev.some((p) => selectionKey(p) === id) ? prev : [...prev, ctx]))
		setAutoSync(false)
	}, [getRuntime, workbookId])

	const unpinSelection = useCallback((id: string) => {
		setPinnedSelections((prev) => prev.filter((p) => selectionKey(p) !== id))
	}, [])

	const clearPins = useCallback(() => {
		setPinnedSelections([])
	}, [])

	const appendChat = useCallback((message: AiMessage) => {
		setChats((prev) => [...prev, message])
	}, [])

	const updateChat = useCallback((id: string, patch: Partial<AiMessage>) => {
		setChats((prev) => prev.map((msg) => (msg.id === id ? { ...msg, ...patch } : msg)))
	}, [])

	const resetChangesUi = useCallback(() => {
		clearAllDecorations()
		clearHoverPopup()
		setChangeSet(null)
		setMeta(null)
		setPreparedChanges([])
		setActiveChangeId(null)
		setChangeState({})
		setSelectedCellsByChange({})
		setAppliedCellsByChange({})
		setIgnoredCellsByChange({})
	}, [clearAllDecorations, clearHoverPopup])

	const runSuggest = useCallback(
		async (instructionText: string, parentId?: string) => {
			const normalized = instructionText.trim()
			if (!normalized) return

			resetChangesUi()
			setLoading(true)
			setError(null)
			setWarn(null)

			const client = ensureApi()
			if (!client) {
				setLoading(false)
				return
			}

			const rt = getRuntime()
			if (!rt) {
				setLoading(false)
				setError('Univer runtime 未就绪。')
				return
			}

			const selection = collectActiveSelectionContexts({ rt, workbookId })
			const ctx = selection?.current ?? null
			if (!ctx || !ctx.range) {
				const msg = '无法获取选区：请先在表格里选中一个区域。'
				setLoading(false)
				setError(msg)
				appendChat({
					id: makeChatId(),
					role: 'assistant',
					parentId,
					status: 'error',
					content: msg,
				})
				return
			}

			setCurrentSelection(ctx)
			setImplicitSelections(selection?.selections ?? [])

			const assistantId = makeChatId()
			appendChat({
				id: assistantId,
				role: 'assistant',
				parentId,
				status: 'loading',
				content: '正在生成建议…',
			})

			try {
				const extras = [...pinnedSelections, ...(selection?.selections ?? [])]
				const toonPayload = buildToonContext({ workbookId, current: ctx, extras })
				const toonText = formatStructured(toonPayload, { format: 'toon' }).text
				const structured: UniverAiSuggestInput['context'] = {
					format: 'toon',
					contentType: 'text/plain',
					text: toonText,
				}

				const res = await client.suggestEdits({
					workbookId,
					instruction: normalized,
					context: structured,
					contextHint: { sheetId: ctx.sheetId, range: ctx.range, a1: ctx.a1 },
				})
				setChangeSet(res.changeSet)
				setMeta(res.meta ?? null)

				const changes = res.changeSet?.changes ?? []
				const prepared: PreparedAiChange[] = []
				const workbook = rt.api.getActiveWorkbook()
				for (const change of changes) {
					if (!workbook) break
					const sheet = change.sheetId ? workbook.getSheetBySheetId(change.sheetId) : workbook.getActiveSheet()
					if (!sheet) continue
					const range = sheet.getRange({
						startRow: change.range.startRow,
						startColumn: change.range.startCol,
						endRow: change.range.endRow,
						endColumn: change.range.endCol,
					})
					const oldDisplayValues = range.getDisplayValues()
					prepared.push(computePreparedChange({ change, oldDisplayValues }))
				}

				setPreparedChanges(prepared)
				setActiveChangeId(prepared[0]?.id ?? null)

				const initialPreviewId = previewMode === 'overlay' ? (prepared[0]?.id ?? null) : null
				const nextState: Record<string, ChangeState> = {}
				const nextSelected: Record<string, Record<string, boolean>> = {}
				const nextApplied: Record<string, Record<string, boolean>> = {}
				const nextIgnored: Record<string, Record<string, boolean>> = {}
				for (const ch of prepared) {
					nextState[ch.id] = initialPreviewId && ch.id === initialPreviewId ? 'preview' : 'idle'
					nextApplied[ch.id] = {}
					nextIgnored[ch.id] = {}
					const selected: Record<string, boolean> = {}
					for (const d of ch.cellDiffs) selected[`${d.row}:${d.col}`] = true
					nextSelected[ch.id] = selected
				}
				setChangeState(nextState)
				setAppliedCellsByChange(nextApplied)
				setIgnoredCellsByChange(nextIgnored)
				setSelectedCellsByChange(nextSelected)

				if (previewMode === 'overlay' && initialPreviewId) {
					const initial = prepared.find((c) => c.id === initialPreviewId) ?? null
					if (initial) {
						const segments = highlightSegmentsForChange(rt, initial, 'preview')
						decorationsRef.current.set(initial.id, segments)
					}
				}

				const changeCount = changes.length
				const summary = res.changeSet?.summary
				updateChat(assistantId, {
					status: 'complete',
					content: changeCount ? `已生成 ${changeCount} 条建议。${summary ? `\n${summary}` : ''}` : '未生成可用的变更建议。',
				})
				setTab('changes')
			} catch (err) {
				const msg = rpcErrorMessage(err, '生成建议失败')
				setError(msg)
				updateChat(assistantId, { status: 'error', content: `生成失败：${msg}` })
			} finally {
				setLoading(false)
			}
		},
		[
			appendChat,
			clearAllDecorations,
			ensureApi,
			getRuntime,
			pinnedSelections,
			previewMode,
			updateChat,
			workbookId,
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
			void runSuggest(text, userMessage.id)
		},
		[appendChat, runSuggest],
	)

	const previewChange = useCallback(
		async (changeId: string) => {
			await runBusy({ kind: 'preview', changeId }, async () => {
				const rt = getRuntime()
				if (!rt) return
				const ch = preparedChanges.find((c) => c.id === changeId)
				if (!ch) return

				const state = changeState[changeId] ?? 'idle'
				if (state === 'rejected') return
				const appliedByCell = appliedCellsByChange[changeId] ?? {}
				const nextState: ChangeState = state === 'idle' ? 'preview' : state

				setWarn(null)
				locateChange(rt as any, ch, state === 'applied' ? 'applied' : 'preview')

				if (previewMode === 'overlay') {
					const toIdle: string[] = []
					for (const other of preparedChangesRef.current) {
						if (other.id === changeId) continue
						if ((changeState[other.id] ?? 'idle') === 'preview') toIdle.push(other.id)
					}
					if (toIdle.length) {
						setChangeState((prev) => {
							const next = { ...prev }
							for (const id of toIdle) next[id] = 'idle'
							return next
						})
						for (const id of toIdle) refreshDecorationsFor(id, { state: 'idle' })
					}
				}

				if (previewMode === 'inSheet' && nextState !== 'applied') {
					await rt.withUndoBatch(async () => {
						await setChangeValues(rt, ch)
					})
				}

				refreshDecorationsFor(changeId, { state: nextState, applied: appliedByCell })
				setChangeState((prev) => ({ ...prev, [changeId]: nextState }))
				reportDecision({
					workbookId,
					changeId,
					action: 'preview',
					op: ch.op,
					range: ch.range,
					sheetId: ch.sheetId,
					reason: ch.reason,
				})
				setTab('changes')
			})
		},
		[
			appliedCellsByChange,
			changeState,
			getRuntime,
			preparedChanges,
			previewMode,
			refreshDecorationsFor,
			reportDecision,
			runBusy,
			workbookId,
		],
	)

	useEffect(() => {
		if (previewMode !== 'overlay') return
		if (!activeChangeId) return
		if ((changeState[activeChangeId] ?? 'idle') !== 'idle') return
		void previewChange(activeChangeId)
	}, [activeChangeId, changeState, previewChange, previewMode])

	const applyChangeCore = useCallback(
		async (changeId: string, opts: { locate?: boolean } = {}) => {
			const rt = getRuntime()
			if (!rt) return
			const ch = preparedChanges.find((c) => c.id === changeId)
			if (!ch) return
			const ignored = ignoredCellsByChange[changeId] ?? {}
			const currentApplied = appliedCellsByChange[changeId] ?? {}
			const diffsToWrite = ch.cellDiffs.filter((d) => {
				const key = `${d.row}:${d.col}`
				return !ignored[key] && !currentApplied[key]
			})

			setWarn(null)
			const locate = opts.locate !== false
			if (locate) locateChange(rt as any, ch, 'preview')
			await rt.withUndoBatch(async () => {
				if (previewMode === 'overlay') {
					if (!diffsToWrite.length) return
					const workbook = rt.api.getActiveWorkbook()
					if (!workbook) return
					const sheet = ch.sheetId ? workbook.getSheetBySheetId(ch.sheetId) : workbook.getActiveSheet()
					if (!sheet) return
					const ops = buildRowWriteOps(diffsToWrite, (d) => (ch.op === 'clear' ? '' : d.nextValue))
					await applyWriteOps(sheet, ops, { yieldEvery: 18 })
					return
				}
				await setChangeValues(rt, ch)
			})

			const nextApplied = { ...currentApplied }
			for (const d of ch.cellDiffs) {
				const key = `${d.row}:${d.col}`
				if (ignored[key]) continue
				nextApplied[key] = true
			}
			setAppliedCellsByChange((prev) =>
				create(prev, (draft) => {
					draft[changeId] = nextApplied
				}),
			)
			refreshDecorationsFor(changeId, { state: 'applied', applied: nextApplied })
			setChangeState((prev) => ({ ...prev, [changeId]: 'applied' }))
			if (locate) locateChange(rt as any, ch, 'applied')
			reportDecision({
				workbookId,
				changeId,
				action: 'apply',
				op: ch.op,
				range: ch.range,
				sheetId: ch.sheetId,
				reason: ch.reason,
			})
			setTab('changes')
		},
		[
			appliedCellsByChange,
			getRuntime,
			ignoredCellsByChange,
			preparedChanges,
			previewMode,
			refreshDecorationsFor,
			reportDecision,
			workbookId,
		],
	)

	const applyChange = useCallback(
		async (changeId: string) => {
			await runBusy({ kind: 'apply', changeId }, async () => {
				await applyChangeCore(changeId)
			})
		},
		[applyChangeCore, runBusy],
	)

	const undoChangeCore = useCallback(
		async (changeId: string, opts: { locate?: boolean } = {}) => {
			const rt = getRuntime()
			if (!rt) return
			const ch = preparedChanges.find((c) => c.id === changeId)
			if (!ch) return
			const applied = appliedCellsByChange[changeId] ?? {}
			const diffsToUndo = ch.cellDiffs.filter((d) => Boolean(applied[`${d.row}:${d.col}`]))

			setWarn(null)
			const locate = opts.locate !== false
			if (locate) locateChange(rt as any, ch, 'preview')
			await rt.withUndoBatch(async () => {
				if (previewMode === 'overlay') {
					if (!diffsToUndo.length) return
					const workbook = rt.api.getActiveWorkbook()
					if (!workbook) return
					const sheet = ch.sheetId ? workbook.getSheetBySheetId(ch.sheetId) : workbook.getActiveSheet()
					if (!sheet) return
					const ops = buildRowWriteOps(diffsToUndo, (d) => d.oldValue)
					await applyWriteOps(sheet, ops, { yieldEvery: 18 })
					return
				}
				await restoreChangeOldValues(rt, ch)
			})

			setAppliedCellsByChange((prev) =>
				create(prev, (draft) => {
					draft[changeId] = {}
				}),
			)
			const baseState = changeState[changeId] ?? 'idle'
			const nextState: ChangeState = previewMode === 'overlay' && baseState !== 'idle' ? 'preview' : 'idle'
			setChangeState((prev) => ({ ...prev, [changeId]: nextState }))
			refreshDecorationsFor(changeId, { state: nextState, applied: {} })
			if (locate) locateChange(rt as any, ch, 'preview')
			reportDecision({
				workbookId,
				changeId,
				action: 'undo',
				op: ch.op,
				range: ch.range,
				sheetId: ch.sheetId,
				reason: ch.reason,
			})
			setTab('changes')
		},
		[
			appliedCellsByChange,
			changeState,
			getRuntime,
			preparedChanges,
			previewMode,
			refreshDecorationsFor,
			reportDecision,
			workbookId,
		],
	)

	const undoChange = useCallback(
		async (changeId: string) => {
			await runBusy({ kind: 'undo', changeId }, async () => {
				await undoChangeCore(changeId)
			})
		},
		[runBusy, undoChangeCore],
	)

	const rejectChangeCore = useCallback(
		async (changeId: string) => {
			const rt = getRuntime()
			if (!rt) return
			const ch = preparedChanges.find((c) => c.id === changeId)
			if (!ch) return
			const applied = appliedCellsByChange[changeId] ?? {}
			const diffsToUndo = ch.cellDiffs.filter((d) => Boolean(applied[`${d.row}:${d.col}`]))

			setWarn(null)
			locateChange(rt as any, ch, 'preview')
			await rt.withUndoBatch(async () => {
				const state = changeState[changeId] ?? 'idle'
				if (previewMode === 'overlay') {
					if (!diffsToUndo.length) return
					const workbook = rt.api.getActiveWorkbook()
					if (!workbook) return
					const sheet = ch.sheetId ? workbook.getSheetBySheetId(ch.sheetId) : workbook.getActiveSheet()
					if (!sheet) return
					const ops = buildRowWriteOps(diffsToUndo, (d) => d.oldValue)
					await applyWriteOps(sheet, ops, { yieldEvery: 18 })
					return
				}
				if (previewMode === 'inSheet' && (state === 'preview' || state === 'applied')) {
					await restoreChangeOldValues(rt, ch)
				}
			})

			setAppliedCellsByChange((prev) =>
				create(prev, (draft) => {
					draft[changeId] = {}
				}),
			)
			setChangeState((prev) => ({ ...prev, [changeId]: 'rejected' }))
			refreshDecorationsFor(changeId, { state: 'rejected', applied: {} })
			locateChange(rt as any, ch, 'preview')
			reportDecision({
				workbookId,
				changeId,
				action: 'reject',
				op: ch.op,
				range: ch.range,
				sheetId: ch.sheetId,
				reason: ch.reason,
			})
		},
		[
			appliedCellsByChange,
			changeState,
			getRuntime,
			preparedChanges,
			previewMode,
			refreshDecorationsFor,
			reportDecision,
			workbookId,
		],
	)

	const rejectChange = useCallback(
		async (changeId: string) => {
			await runBusy({ kind: 'reject', changeId }, async () => {
				await rejectChangeCore(changeId)
			})
		},
		[rejectChangeCore, runBusy],
	)

	const toggleCellSelected = useCallback(
		(changeId: string, row: number, col: number) => {
			const key = `${row}:${col}`
			if (ignoredCellsByChange[changeId]?.[key]) return
			setSelectedCellsByChange((prev) =>
				create(prev, (draft) => {
					const selected = (draft[changeId] ??= {})
					selected[key] = !selected[key]
				}),
			)
		},
		[ignoredCellsByChange],
	)

	const applySelectedCellsCore = useCallback(
		async (changeId: string) => {
			const rt = getRuntime()
			if (!rt) return
			const ch = preparedChanges.find((c) => c.id === changeId)
			if (!ch) return
			const selected = selectedCellsByChange[changeId] ?? {}
			const applied = appliedCellsByChange[changeId] ?? {}
			const ignored = ignoredCellsByChange[changeId] ?? {}

			const diffs = ch.cellDiffs.filter(
				(d) => selected[`${d.row}:${d.col}`] && !applied[`${d.row}:${d.col}`] && !ignored[`${d.row}:${d.col}`],
			)
			if (!diffs.length) {
				setWarn('没有可应用的选中单元格（可能已全部应用）。')
				return
			}

			setWarn(null)
			locateChange(rt as any, ch, 'preview')
			await rt.withUndoBatch(async () => {
				const workbook = rt.api.getActiveWorkbook()
				if (!workbook) return
				const sheet = ch.sheetId ? workbook.getSheetBySheetId(ch.sheetId) : workbook.getActiveSheet()
				if (!sheet) return
				const ops = buildRowWriteOps(diffs, (d) => (ch.op === 'clear' ? '' : d.nextValue))
				await applyWriteOps(sheet, ops, { yieldEvery: 18 })
			})

			const nextApplied = { ...applied }
			for (const d of diffs) nextApplied[`${d.row}:${d.col}`] = true
			setAppliedCellsByChange((prev) =>
				create(prev, (draft) => {
					draft[changeId] = nextApplied
				}),
			)
			setChangeState((prev) => ({ ...prev, [changeId]: 'applied' }))
			refreshDecorationsFor(changeId, { state: 'applied', applied: nextApplied })
			locateChange(rt as any, ch, 'applied')
			reportDecision({
				workbookId,
				changeId,
				action: 'apply',
				op: ch.op,
				range: ch.range,
				sheetId: ch.sheetId,
				reason: ch.reason,
			})
		},
		[
			appliedCellsByChange,
			getRuntime,
			ignoredCellsByChange,
			preparedChanges,
			refreshDecorationsFor,
			reportDecision,
			selectedCellsByChange,
			workbookId,
		],
	)

	const applySelectedCells = useCallback(
		async (changeId: string) => {
			await runBusy({ kind: 'applySelected', changeId }, async () => {
				await applySelectedCellsCore(changeId)
			})
		},
		[applySelectedCellsCore, runBusy],
	)

	const undoSelectedCellsCore = useCallback(
		async (changeId: string) => {
			const rt = getRuntime()
			if (!rt) return
			const ch = preparedChanges.find((c) => c.id === changeId)
			if (!ch) return
			const selected = selectedCellsByChange[changeId] ?? {}
			const applied = appliedCellsByChange[changeId] ?? {}
			const ignored = ignoredCellsByChange[changeId] ?? {}

			const diffs = ch.cellDiffs.filter(
				(d) => selected[`${d.row}:${d.col}`] && applied[`${d.row}:${d.col}`] && !ignored[`${d.row}:${d.col}`],
			)
			if (!diffs.length) {
				setWarn('没有可撤销的选中单元格（可能未应用）。')
				return
			}

			setWarn(null)
			locateChange(rt as any, ch, 'preview')
			await rt.withUndoBatch(async () => {
				const workbook = rt.api.getActiveWorkbook()
				if (!workbook) return
				const sheet = ch.sheetId ? workbook.getSheetBySheetId(ch.sheetId) : workbook.getActiveSheet()
				if (!sheet) return
				const ops = buildRowWriteOps(diffs, (d) => d.oldValue)
				await applyWriteOps(sheet, ops, { yieldEvery: 18 })
			})

			const nextApplied = { ...applied }
			for (const d of diffs) delete nextApplied[`${d.row}:${d.col}`]
			const baseState = changeState[changeId] ?? 'idle'
			const nextState: ChangeState =
				Object.keys(nextApplied).length > 0 ? 'applied' : baseState === 'idle' ? 'idle' : 'preview'
			setAppliedCellsByChange((prev) =>
				create(prev, (draft) => {
					draft[changeId] = nextApplied
				}),
			)
			setChangeState((prev) => ({ ...prev, [changeId]: nextState }))
			refreshDecorationsFor(changeId, { state: nextState, applied: nextApplied })
			locateChange(rt as any, ch, 'preview')
			reportDecision({
				workbookId,
				changeId,
				action: 'undo',
				op: ch.op,
				range: ch.range,
				sheetId: ch.sheetId,
				reason: ch.reason,
			})
		},
		[
			appliedCellsByChange,
			changeState,
			getRuntime,
			ignoredCellsByChange,
			preparedChanges,
			refreshDecorationsFor,
			reportDecision,
			selectedCellsByChange,
			workbookId,
		],
	)

	const undoSelectedCells = useCallback(
		async (changeId: string) => {
			await runBusy({ kind: 'undoSelected', changeId }, async () => {
				await undoSelectedCellsCore(changeId)
			})
		},
		[runBusy, undoSelectedCellsCore],
	)

	const applyAll = useCallback(async () => {
		const list = preparedChanges.filter((ch) => (changeState[ch.id] ?? 'idle') !== 'rejected')
		if (!list.length) return
		const total = list.length
		await runBusy({ kind: 'applyAll', done: 0, total }, async () => {
			for (let i = 0; i < list.length; i++) {
				const ch = list[i]!
				setBusyOp({ kind: 'applyAll', done: i, total })
				await yieldToBrowser()
				await applyChangeCore(ch.id, { locate: false })
				setBusyOp({ kind: 'applyAll', done: i + 1, total })
			}
		})
	}, [applyChangeCore, changeState, preparedChanges, runBusy])

	const undoAll = useCallback(async () => {
		const list = preparedChanges.filter((ch) => (changeState[ch.id] ?? 'idle') !== 'rejected')
		if (!list.length) return
		const total = list.length
		await runBusy({ kind: 'undoAll', done: 0, total }, async () => {
			for (let i = 0; i < list.length; i++) {
				const ch = list[i]!
				setBusyOp({ kind: 'undoAll', done: i, total })
				await yieldToBrowser()
				await undoChangeCore(ch.id, { locate: false })
				setBusyOp({ kind: 'undoAll', done: i + 1, total })
			}
		})
	}, [changeState, preparedChanges, runBusy, undoChangeCore])

	useEffect(() => {
		if (!preparedChanges.length) {
			clearAllDecorations()
			clearHoverPopup()
		}
		return () => {
			clearAllDecorations()
			clearHoverPopup()
		}
	}, [clearAllDecorations, clearHoverPopup, preparedChanges.length])

	const activePrepared = useMemo(
		() => (activeChangeId ? preparedChanges.find((c) => c.id === activeChangeId) ?? null : null),
		[activeChangeId, preparedChanges],
	)

	useEffect(() => {
		if (tab !== 'changes') return
		if (!activePrepared) return
		const state = changeState[activePrepared.id] ?? 'preview'
		const mode = state === 'applied' ? 'applied' : 'preview'
		const sig = `${activePrepared.id}:${mode}`
		if (lastLocateSigRef.current === sig) return
		lastLocateSigRef.current = sig
		const rt = getRuntime()
		if (!rt) return
		locateChange(rt as any, activePrepared, mode)
	}, [activePrepared, changeState, getRuntime, tab])

	const activeVisibleDiffs = useMemo(() => {
		if (!activePrepared) return []
		const ignored = ignoredCellsByChange[activePrepared.id] ?? {}
		return activePrepared.cellDiffs.filter((d) => !ignored[`${d.row}:${d.col}`])
	}, [activePrepared, ignoredCellsByChange])

	const activeCellState = useMemo(() => {
		if (!activePrepared) return null
		const selected = selectedCellsByChange[activePrepared.id] ?? {}
		const applied = appliedCellsByChange[activePrepared.id] ?? {}
		const ignored = ignoredCellsByChange[activePrepared.id] ?? {}
		let selectedCount = 0
		let appliedCount = 0
		for (const d of activePrepared.cellDiffs) {
			const key = `${d.row}:${d.col}`
			if (ignored[key]) continue
			if (selected[key]) selectedCount++
			if (applied[key]) appliedCount++
		}
		return { selected, applied, ignored, selectedCount, appliedCount }
	}, [activePrepared, appliedCellsByChange, ignoredCellsByChange, selectedCellsByChange])

	const selectionReferences = useMemo(() => {
		const extras: UniverAiContext[] = []
		for (const ctx of pinnedSelections) extras.push(ctx)
		for (const ctx of implicitSelections) {
			const id = selectionKey(ctx)
			if (!extras.some((x) => selectionKey(x) === id)) extras.push(ctx)
		}

		const refs = extras.map((ctx) => ({
			type: 'selection',
			id: selectionKey(ctx),
			label: selectionLabel(ctx),
			meta: selectionMeta(ctx),
			ctx,
			closable: pinnedSelections.some((p) => selectionKey(p) === selectionKey(ctx)),
		}))
		if (currentSelection) {
			const currentId = selectionKey(currentSelection)
			if (!refs.some((ref) => ref.id === currentId)) {
				refs.unshift({
					type: 'selection',
					id: currentId,
					label: `当前 · ${selectionLabel(currentSelection)}`,
					meta: selectionMeta(currentSelection),
					ctx: currentSelection,
					closable: false,
				})
			}
		}
		return refs
	}, [currentSelection, implicitSelections, pinnedSelections])

	const aiConnected = Boolean(ready && api)

	const toonContext = useMemo(() => {
		if (!currentSelection) return null
		const extras: UniverAiContext[] = []
		for (const ctx of pinnedSelections) extras.push(ctx)
		for (const ctx of implicitSelections) {
			const id = selectionKey(ctx)
			if (!extras.some((x) => selectionKey(x) === id)) extras.push(ctx)
		}
		return buildToonContext({ workbookId, current: currentSelection, extras })
	}, [currentSelection, implicitSelections, pinnedSelections, workbookId])

	const toonPreviewText = useMemo(() => {
		if (!toonContext) return null
		return formatStructured(toonContext, { format: 'toon' }).text
	}, [toonContext])

	const visibleDiffCountByChange = useMemo(() => {
		const map: Record<string, number> = {}
		for (const ch of preparedChanges) {
			const ignored = ignoredCellsByChange[ch.id] ?? {}
			map[ch.id] = ch.cellDiffs.filter((d) => !ignored[`${d.row}:${d.col}`]).length
		}
		return map
	}, [ignoredCellsByChange, preparedChanges])

	return {
		// state
		tab,
		setTab,
		instruction,
		setInstruction,
		chats,
		loading,
		busy,
		busyOp,
		error,
		warn,
		autoSync,
		setAutoSync,
		currentSelection,
		pinnedSelections,
		implicitSelections,
		toonPreviewText,
		changeSet,
		meta,
		preparedChanges,
		visibleDiffCountByChange,
		activeChangeId,
		setActiveChangeId,
		changeState,
		previewMode,
		hoverPopup,
		virtualRender,
		hoverIndexSize: hoverIndexRef.current.size,

		// derived
		aiConnected,
		selectionReferences,
		activePrepared,
		activeVisibleDiffs,
		activeCellState,

		// helpers (for UI)
		selectionKey,
		selectionLabel,
		selectionMeta,

		// actions
		setPreviewMode,
		setHoverPopup,
		setVirtualRender,
		refreshSelection,
		pinCurrentSelection,
		unpinSelection,
		clearPins,
		handleAiSend,
		previewChange,
		applyChange,
		undoChange,
		rejectChange,
		applyAll,
		undoAll,
		toggleCellSelected,
		applySelectedCells,
		undoSelectedCells,
		rangeToA1,
		cellToA1,
	}
}
