import type { UniverAiContext } from '@pluxel/univer-headless/protocol'
import { useSyncExternalStore } from 'react'

import { rangeToA1, type UniverRangeLike } from './a1'

type Listener = () => void

export type UniverAiWriteScopeMode = 'sheet' | 'ranges'

export type UniverAiWriteScopeItem = Readonly<{
	/** The sheetId for highlighting and validation. */
	sheetId?: string
	/** 0-based range. */
	range: UniverRangeLike
	/** A1 with sheet prefix (e.g. `'Sheet 1'!A1:C3`). */
	a1: string
}>

export type UniverAiWriteScopeState = Readonly<{
	mode: UniverAiWriteScopeMode
	items: ReadonlyArray<UniverAiWriteScopeItem>
}>

type Store = {
	state: UniverAiWriteScopeState
	listeners: Set<Listener>
}

const stores = new Map<string, Store>()

function getKey(workbookId: string) {
	return String(workbookId ?? '').trim()
}

function getStore(workbookId: string): Store {
	const key = getKey(workbookId)
	if (!key) {
		return { state: { mode: 'sheet', items: [] }, listeners: new Set() }
	}
	let store = stores.get(key)
	if (!store) {
		store = { state: { mode: 'sheet', items: [] }, listeners: new Set() }
		stores.set(key, store)
	}
	return store
}

function emit(store: Store) {
	for (const l of store.listeners) l()
}

function itemKey(item: UniverAiWriteScopeItem) {
	const r = item.range
	const rect = `${r.startRow}:${r.startCol}-${r.endRow}:${r.endCol}`
	return `${item.sheetId ?? 'sheet'}:${rect}`
}

function sheetPrefixFromA1(a1: string) {
	const raw = String(a1 ?? '').trim()
	const idx = raw.indexOf('!')
	return idx >= 0 ? raw.slice(0, idx) : ''
}

function selectionToWriteItem(ctx: UniverAiContext): UniverAiWriteScopeItem | null {
	const sheetId = ctx.selection.sheetId ? String(ctx.selection.sheetId) : undefined
	const prefix = sheetPrefixFromA1(ctx.selection.a1 ?? '')
	const orig = ctx.selection.orig
	const r = orig
		? { startRow: orig.startRow, startCol: orig.startCol, endRow: orig.endRow, endCol: orig.endCol }
		: ctx.selection.range
	if (!r) return null
	const a1 = prefix ? `${prefix}!${rangeToA1(r)}` : rangeToA1(r)
	return { sheetId, range: r, a1 }
}

function uniq(items: readonly UniverAiWriteScopeItem[]) {
	const out: UniverAiWriteScopeItem[] = []
	const seen = new Set<string>()
	for (const it of items) {
		if (!it) continue
		const k = itemKey(it)
		if (seen.has(k)) continue
		seen.add(k)
		out.push(it)
	}
	return out
}

export function getUniverAiWriteScopeState(workbookId: string): UniverAiWriteScopeState {
	return getStore(workbookId).state
}

export function subscribeUniverAiWriteScopeState(workbookId: string, listener: Listener): () => void {
	const store = getStore(workbookId)
	store.listeners.add(listener)
	return () => {
		store.listeners.delete(listener)
	}
}

export function useUniverAiWriteScopeState(workbookId: string): UniverAiWriteScopeState {
	return useSyncExternalStore(
		(cb) => subscribeUniverAiWriteScopeState(workbookId, cb),
		() => getUniverAiWriteScopeState(workbookId),
		() => ({ mode: 'sheet', items: [] }),
	)
}

export function resetUniverAiWriteScopeToSheet(workbookId: string) {
	const store = getStore(workbookId)
	if (store.state.mode === 'sheet' && !store.state.items.length) return
	store.state = { mode: 'sheet', items: [] }
	emit(store)
}

export function limitUniverAiWriteScopeToSelections(workbookId: string, selections: readonly UniverAiContext[]) {
	const store = getStore(workbookId)
	const items = uniq(selections.map(selectionToWriteItem).filter((x): x is UniverAiWriteScopeItem => Boolean(x)))
	store.state = { mode: 'ranges', items }
	emit(store)
}

export function addUniverAiWriteScopeFromSelections(workbookId: string, selections: readonly UniverAiContext[]) {
	const store = getStore(workbookId)
	const add = selections.map(selectionToWriteItem).filter((x): x is UniverAiWriteScopeItem => Boolean(x))
	const next = uniq((store.state.mode === 'ranges' ? store.state.items : []).concat(add))
	store.state = { mode: 'ranges', items: next }
	emit(store)
}

export function removeUniverAiWriteScope(workbookId: string, a1: string) {
	const store = getStore(workbookId)
	if (store.state.mode !== 'ranges') return
	const raw = String(a1 ?? '').trim()
	if (!raw) return
	const next = store.state.items.filter((it) => it.a1 !== raw)
	if (next.length === store.state.items.length) return
	store.state = { mode: 'ranges', items: next }
	emit(store)
}

export function disposeUniverAiWriteScope(workbookId: string) {
	const key = getKey(workbookId)
	if (!key) return
	stores.delete(key)
}

