export function coerceSheets(raw: any): any[] {
	if (!raw) return []
	if (Array.isArray(raw)) return raw
	if (typeof raw?.values === 'function') {
		try {
			return Array.from(raw.values())
		} catch {}
	}
	if (typeof raw?.[Symbol.iterator] === 'function') {
		try {
			return Array.from(raw as Iterable<unknown>)
		} catch {}
	}
	if (typeof raw === 'object') return Object.values(raw)
	return []
}

export function unwrapSheetEntry(entry: any): any {
	// Some Univer variants return Map entries like [id, sheet].
	return Array.isArray(entry) && entry.length >= 2 ? entry[1] : entry
}

