export function scopesForRequest<T extends { sheetId?: string; sheetName?: string }>(
	scopes: readonly T[],
	req: Readonly<{
		sheetId?: string
		sheetName?: string
		defaultSheetId?: string
		defaultSheetName?: string
		/** Optional id->name map to allow sheetId-only requests to match name-only scopes. */
		sheetIdToName?: ReadonlyMap<string, string>
	}>,
): T[] {
	const sid = String(req.sheetId ?? '').trim()
	const sname = String(req.sheetName ?? '').trim()

	if (sid) {
		const byId = scopes.filter((s) => s.sheetId && s.sheetId === sid)
		if (byId.length) return byId
	}

	const namesToTry: string[] = []
	if (sname) namesToTry.push(sname)
	if (sid && req.sheetIdToName) {
		const mapped = String(req.sheetIdToName.get(sid) ?? '').trim()
		if (mapped && !namesToTry.includes(mapped)) namesToTry.push(mapped)
	}
	for (const name of namesToTry) {
		const byName = scopes.filter((s) => s.sheetName && s.sheetName === name)
		if (byName.length) return byName
	}

	// Default-sheet fallback: only allow "no-sheet" scopes when the request targets the default sheet.
	const defaultId = String(req.defaultSheetId ?? '').trim()
	const defaultName = String(req.defaultSheetName ?? '').trim()
	const requestedNameViaId =
		sid && req.sheetIdToName ? String(req.sheetIdToName.get(sid) ?? '').trim() : ''
	const isDefault =
		(!sid && !sname) ||
		(!!defaultId && !!sid && sid === defaultId) ||
		(!!defaultName && !!sname && sname === defaultName) ||
		(!!defaultName && !!requestedNameViaId && requestedNameViaId === defaultName)
	if (!isDefault) return []
	return scopes.filter((s) => !s.sheetName)
}

