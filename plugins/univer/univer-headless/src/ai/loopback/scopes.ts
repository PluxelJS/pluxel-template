import type { UniverRange } from '../../protocol'
import type { UniverAiBridge } from '../bridge'
import { parseA1Range } from '../a1'
import type { A1Scope } from '../mcp/context'

export function normalizeA1List(list: readonly string[] | undefined): string[] {
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

export function toScopes(list: readonly string[]): A1Scope[] {
	return list.map((a1) => {
		const parsed = parseA1Range(a1)
		return { a1: parsed.a1, sheetName: parsed.sheetName, range: parsed.range }
	})
}

export function rangeWithin(a: UniverRange, b: UniverRange) {
	return a.startRow >= b.startRow && a.endRow <= b.endRow && a.startCol >= b.startCol && a.endCol <= b.endCol
}

export function scopeListForSheet(scopes: A1Scope[], sheetId?: string, sheetName?: string): A1Scope[] {
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

export function buildSheetMaps(bridge: UniverAiBridge) {
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

export function attachSheetIds(scopes: A1Scope[], sheetNameToId: Map<string, string>) {
	for (const s of scopes) {
		if (!s.sheetName) continue
		const sid = sheetNameToId.get(s.sheetName)
		if (sid) s.sheetId = sid
	}
}

