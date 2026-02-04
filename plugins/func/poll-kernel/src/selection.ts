import type { Code, PollSpec, SelKind, Selection } from './core.js'
import { normalizeSpec } from './spec.js'

export type SelectionEncoding = {
	kind: 'BITSET64' | 'U16'
	data: string
}

export type NormalizedSpec = ReturnType<typeof normalizeSpec>

export function buildSelection(spec: PollSpec, selections: string[]): Selection | Code {
	const normalized = normalizeSpec(spec)
	return parseSelection(selections, normalized)
}

export function parseSelection(selections: string[], normalized: NormalizedSpec): Selection | Code {
	if (!Array.isArray(selections)) return 'INVALID'
	if (normalized.spec.mode === 'single') {
		if (selections.length !== 1) return 'INVALID'
	} else {
		if (selections.length === 0) return 'INVALID'
		if (selections.length > normalized.maxSelections) return 'INVALID'
	}

	if (normalized.selectionKind === 'bitset64') {
		let bits = 0n
		for (const id of selections) {
			const idx = normalized.choiceIndexById.get(id)
			if (idx === undefined) return 'INVALID'
			const mask = 1n << BigInt(idx)
			if ((bits & mask) !== 0n) return 'INVALID'
			bits |= mask
		}
		return { kind: 'bitset64', bits }
	}

	const indices: number[] = []
	const seen = new Set<number>()
	for (const id of selections) {
		const idx = normalized.choiceIndexById.get(id)
		if (idx === undefined) return 'INVALID'
		if (seen.has(idx)) return 'INVALID'
		seen.add(idx)
		indices.push(idx)
	}
	indices.sort((a, b) => a - b)
	return { kind: 'sortedU16', idx: new Uint16Array(indices) }
}

export function validateSelection(sel: Selection, normalized: NormalizedSpec): Code | null {
	if (sel.kind !== normalized.selectionKind) return 'INVALID'
	if (sel.kind === 'bitset64') {
		if (normalized.choiceCount < 64) {
			const mask = (1n << BigInt(normalized.choiceCount)) - 1n
			if ((sel.bits & ~mask) !== 0n) return 'INVALID'
		}
	} else {
		let last = -1
		for (let i = 0; i < sel.idx.length; i += 1) {
			const v = sel.idx[i]!
			if (v <= last) return 'INVALID'
			if (v >= normalized.choiceCount) return 'INVALID'
			last = v
		}
	}

	const count = selectionCount(sel)
	if (normalized.spec.mode === 'single') {
		if (count !== 1) return 'INVALID'
	} else {
		if (count === 0) return 'INVALID'
		if (count > normalized.maxSelections) return 'INVALID'
	}

	return null
}

export function selectionEquals(a: Selection, b: Selection): boolean {
	if (a.kind !== b.kind) return false
	if (a.kind === 'bitset64') return a.bits === (b as { bits: bigint }).bits
	const aIdx = a.idx
	const bIdx = (b as { idx: Uint16Array }).idx
	if (aIdx.length !== bIdx.length) return false
	for (let i = 0; i < aIdx.length; i += 1) {
		if (aIdx[i] !== bIdx[i]) return false
	}
	return true
}

export function selectionToIndices(sel: Selection): number[] {
	if (sel.kind === 'bitset64') {
		const indices: number[] = []
		forEachBitIndex(sel.bits, (idx) => indices.push(idx))
		return indices
	}
	return Array.from(sel.idx)
}

export function diffSelection(
	oldSel: Selection,
	newSel: Selection,
	onRemoved: (idx: number) => void,
	onAdded: (idx: number) => void,
): void {
	if (oldSel.kind !== newSel.kind) {
		throw new Error('[PollKernel] selection kind mismatch')
	}
	if (oldSel.kind === 'bitset64') {
		diffBitset(oldSel.bits, (newSel as { bits: bigint }).bits, onRemoved, onAdded)
		return
	}
	diffSorted(oldSel.idx, (newSel as { idx: Uint16Array }).idx, onRemoved, onAdded)
}

export function forEachIntersection(
	oldSel: Selection,
	newSel: Selection,
	cb: (idx: number) => void,
): void {
	if (oldSel.kind !== newSel.kind) {
		throw new Error('[PollKernel] selection kind mismatch')
	}
	if (oldSel.kind === 'bitset64') {
		const bits = oldSel.bits & (newSel as { bits: bigint }).bits
		forEachBitIndex(bits, cb)
		return
	}
	const oldIdx = oldSel.idx
	const newIdx = (newSel as { idx: Uint16Array }).idx
	let i = 0
	let j = 0
	while (i < oldIdx.length && j < newIdx.length) {
		const a = oldIdx[i]!
		const b = newIdx[j]!
		if (a === b) {
			cb(a)
			i += 1
			j += 1
		} else if (a < b) {
			i += 1
		} else {
			j += 1
		}
	}
}

export function encodeSelection(sel: Selection): SelectionEncoding {
	if (sel.kind === 'bitset64') {
		return { kind: 'BITSET64', data: `0x${sel.bits.toString(16)}` }
	}
	return { kind: 'U16', data: JSON.stringify(Array.from(sel.idx)) }
}

export function decodeSelection(kind: string, data: string): Selection | null {
	if (kind === 'BITSET64') {
		const text = data.startsWith('0x') || data.startsWith('0X') ? data.slice(2) : data
		const bits = BigInt(`0x${text || '0'}`)
		return { kind: 'bitset64', bits }
	}
	if (kind === 'U16') {
		const parsed = JSON.parse(data) as number[]
		return { kind: 'sortedU16', idx: new Uint16Array(parsed) }
	}
	return null
}

export function selectionKindLabel(kind: SelKind): 'BITSET64' | 'U16' {
	return kind === 'bitset64' ? 'BITSET64' : 'U16'
}

function selectionCount(sel: Selection): number {
	if (sel.kind === 'bitset64') {
		let count = 0
		let x = sel.bits
		while (x !== 0n) {
			x &= x - 1n
			count += 1
		}
		return count
	}
	return sel.idx.length
}

function ctz64(x: bigint): number {
	let n = 0
	let v = x
	while ((v & 1n) === 0n) {
		v >>= 1n
		n += 1
	}
	return n
}

function forEachBitIndex(bits: bigint, cb: (idx: number) => void): void {
	let x = bits
	while (x !== 0n) {
		const lsb = x & -x
		cb(ctz64(lsb))
		x ^= lsb
	}
}

function diffBitset(
	oldBits: bigint,
	newBits: bigint,
	onRemoved: (idx: number) => void,
	onAdded: (idx: number) => void,
): void {
	let removed = oldBits & ~newBits
	let added = newBits & ~oldBits
	forEachBitIndex(removed, onRemoved)
	forEachBitIndex(added, onAdded)
}

function diffSorted(
	oldIdx: Uint16Array,
	newIdx: Uint16Array,
	onRemoved: (idx: number) => void,
	onAdded: (idx: number) => void,
): void {
	let i = 0
	let j = 0
	while (i < oldIdx.length && j < newIdx.length) {
		const a = oldIdx[i]!
		const b = newIdx[j]!
		if (a === b) {
			i += 1
			j += 1
		} else if (a < b) {
			onRemoved(a)
			i += 1
		} else {
			onAdded(b)
			j += 1
		}
	}
	while (i < oldIdx.length) {
		onRemoved(oldIdx[i]!)
		i += 1
	}
	while (j < newIdx.length) {
		onAdded(newIdx[j]!)
		j += 1
	}
}
