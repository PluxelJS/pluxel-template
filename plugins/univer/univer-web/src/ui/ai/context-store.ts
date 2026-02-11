import type { UniverAiContext } from '@pluxel/univer-headless/protocol'
import { useSyncExternalStore } from 'react'

type Listener = () => void

export type UniverAiContextState = Readonly<{
	pinnedSelections: ReadonlyArray<UniverAiContext>
}>

type Store = {
	state: UniverAiContextState
	listeners: Set<Listener>
}

const stores = new Map<string, Store>()

function getStore(workbookId: string): Store {
	const key = String(workbookId ?? '').trim()
	if (!key) {
		return {
			state: { pinnedSelections: [] },
			listeners: new Set(),
		}
	}
	let store = stores.get(key)
	if (!store) {
		store = { state: { pinnedSelections: [] }, listeners: new Set() }
		stores.set(key, store)
	}
	return store
}

function emit(store: Store) {
	for (const l of store.listeners) l()
}

function selectionKey(ctx: UniverAiContext) {
	const range = ctx.selection.range
	const keyRange = range ? `${range.startRow}:${range.startCol}-${range.endRow}:${range.endCol}` : 'range:unknown'
	return `${ctx.workbookId}:${ctx.selection.sheetId ?? 'sheet'}:${keyRange}`
}

export function getUniverAiContextState(workbookId: string): UniverAiContextState {
	return getStore(workbookId).state
}

export function subscribeUniverAiContextState(workbookId: string, listener: Listener): () => void {
	const store = getStore(workbookId)
	store.listeners.add(listener)
	return () => {
		store.listeners.delete(listener)
	}
}

export function useUniverAiContextState(workbookId: string): UniverAiContextState {
	return useSyncExternalStore(
		(cb) => subscribeUniverAiContextState(workbookId, cb),
		() => getUniverAiContextState(workbookId),
		() => ({ pinnedSelections: [] }),
	)
}

export function pinUniverAiSelections(workbookId: string, selections: readonly UniverAiContext[]): { added: number; total: number } {
	const store = getStore(workbookId)
	const base = store.state.pinnedSelections
	if (!selections.length) return { added: 0, total: base.length }

	const next: UniverAiContext[] = [...base]
	const seen = new Set(base.map(selectionKey))
	let added = 0
	for (const s of selections) {
		if (!s || s.workbookId !== workbookId) continue
		const key = selectionKey(s)
		if (seen.has(key)) continue
		seen.add(key)
		next.push(s)
		added += 1
	}
	if (!added) return { added: 0, total: base.length }
	store.state = { pinnedSelections: next }
	emit(store)
	return { added, total: next.length }
}

export function unpinUniverAiSelection(workbookId: string, key: string): boolean {
	const store = getStore(workbookId)
	const base = store.state.pinnedSelections
	const next = base.filter((s) => selectionKey(s) !== key)
	if (next.length === base.length) return false
	store.state = { pinnedSelections: next }
	emit(store)
	return true
}

export function clearUniverAiSelections(workbookId: string): void {
	const store = getStore(workbookId)
	if (!store.state.pinnedSelections.length) return
	store.state = { pinnedSelections: [] }
	emit(store)
}

export function disposeUniverAiContext(workbookId: string) {
	const key = String(workbookId ?? '').trim()
	if (!key) return
	stores.delete(key)
}

