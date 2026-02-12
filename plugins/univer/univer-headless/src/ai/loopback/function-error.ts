export function inferAxFunctionErrorField(toolName: string, message: string): string {
	const m = String(message ?? '').toLowerCase()
	const name = String(toolName ?? '')

	if (m.includes('invalid regex')) return 'query'
	if (m.includes('range or a1 required') || m.includes('a1 required')) return 'a1'
	if (
		m.includes('invalid a1') ||
		m.includes('a1 must include sheet name') ||
		m.includes('read range out of scope') ||
		m.includes('write range out of scope')
	)
		return 'a1'
	if (m.includes('write not permitted') || m.includes('no write scopes')) return 'writeScopes'
	if (m.includes('sheet not found') || m.includes('read sheet not allowed') || m.includes('write sheet not allowed')) {
		return name.includes('sheet') ? 'sheetName' : 'sheetId'
	}
	if (m.includes('write sheet reference required')) return name.includes('sheet') ? 'sheetName' : 'sheetId'
	if (m.includes('invalid values matrix') || m.includes('set_range_data invalid values')) return 'values'
	if (m.includes('fill_formula')) return 'formula'
	if (m.includes('changes exceed limit')) return 'contract'
	if (m.includes('ops exceed limit')) return 'ops'

	return 'input'
}

export function hintForToolError(toolName: string, message: string) {
	const name = String(toolName ?? '').trim()
	const m = String(message ?? '')
	const lower = m.toLowerCase()

	if (lower.includes('range or a1 required') || lower.includes('a1 required')) {
		return 'Provide either a1 (preferred, ALWAYS sheet-qualified like Sheet1!A1:B10) or range (0-based indices). If sheet name contains spaces, quote it: \'Sheet 1\'!A1:B10.'
	}
	if (lower.includes('a1 must include sheet name')) {
		return 'A1 must be sheet-qualified, e.g. Sheet1!A1:B10 or \'Sheet 1\'!A1:B10. Do not use bare A1 like A1:B10.'
	}
	if (lower.includes('sheetname required when using numeric range')) {
		return 'For numeric range inputs, you must provide sheetName. Prefer using a sheet-qualified A1 (sheetName!A1:B10) for clarity.'
	}
	if (lower.includes('write not permitted') || lower.includes('no write scopes')) {
		return 'Write permission is not granted. Ask the user to enable write permission (set write scope to sheet or specific ranges), then retry the write tools.'
	}
	if (lower.includes('read sheet not allowed')) {
		return 'You can only read within readScopes. Stay inside the allowed A1 scopes; if you must read another area, ask the user to expand read scope.'
	}
	if (lower.includes('read range out of scope')) {
		return 'Read was outside the allowed scopes. Use smaller, targeted A1 ranges strictly inside the provided readScopes.'
	}
	if (lower.includes('write sheet not allowed')) {
		return 'You can only write within writeScopes. Restrict edits to the allowed A1 scopes; if the requested edit is outside, ask the user to expand scope.'
	}
	if (lower.includes('write range out of scope')) {
		return 'Write was outside the allowed scopes. Narrow the target range or adjust A1 to stay inside writeScopes.'
	}
	if (lower.includes('write sheet reference required')) {
		return 'Provide sheetId or sheetName. If unsure, call get_sheets to discover valid sheet ids/names, then retry.'
	}

	if (lower.includes('set_range_data invalid values') || lower.includes('invalid values matrix')) {
		const dim = m.match(/expected\s+(\d+x\d+)/i)?.[1]
		return dim
			? `set_range_data requires a dense 2D matrix exactly matching the target range size (${dim}). For formulas, provide a full ${dim} matrix (each cell can be its own formula string).`
			: 'set_range_data requires a dense 2D matrix exactly matching the target range size (rows x cols). For formulas, provide a full per-cell formula matrix.'
	}
	if (lower.includes('fill_formula')) {
		return 'fill_formula requires a formula string starting with "=". Use $ to lock rows/cols that should not shift, or use set_range_data with an explicit matrix for non-uniform formulas.'
	}
	if (name.includes('set_ranges_data') || name.includes('get_ranges_data') || lower.includes('set_ranges_data') || lower.includes('get_ranges_data')) {
		return 'Batch tools accept arrays: get_ranges_data({ranges:[...]}) and set_ranges_data({updates:[...]}). Each item must provide either a1 or range, plus optional sheetId/sheetName.'
	}
	if (lower.includes('sheet not found')) {
		return 'The referenced sheetId/sheetName was not found. Call get_sheets to discover valid sheet ids/names, then retry with the correct sheet.'
	}
	if (lower.includes('invalid a1')) {
		return 'Use a valid sheet-qualified A1 notation like Sheet1!A1:B10 (preferred). Avoid column-only forms like T:T.'
	}
	if (lower.includes('invalid regex')) {
		return 'Provide a valid regex pattern, or change match mode to "contains" or "exact".'
	}
	if (lower.includes('changes exceed limit') || lower.includes('ops exceed limit')) {
		return 'You hit contract limits. Batch fewer edits per step (prefer set_ranges_data), and reduce the change set.'
	}
	return 'Adjust the tool input and retry. If needed, call get_sheets/get_active_unit_id first to confirm sheet ids.'
}
