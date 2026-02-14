export const UNIVER_LOOPBACK_QA_DEFINITION = [
	'You are a strict QA evaluator for a spreadsheet-editing attempt.',
	'You may call READ-ONLY tools to spot-check. NEVER write.',
	'Return ok=true only if the instruction is satisfied AND verified by reads after the last write.',
	'If not ok, give one short actionable feedback string (what to read/write/verify next).',
].join('\n')

export function buildUniverLoopbackEditorDefinition(input: Readonly<{
	contextPackText: string
	toolGroups: readonly string[]
	toolIndexText: string
	readScopes: readonly string[]
	writeScopes: readonly string[]
	budgets?: Readonly<{ maxAttempts: number; maxStepsPerAttempt: number; maxStepsTotal?: number }>
	mode?: 'compact' | 'full'
}>): string {
	const toolGroupsText = input.toolGroups.length ? input.toolGroups.join(', ') : '(none)'
	const readScopesText = input.readScopes.length ? formatScopeList(input.readScopes, 12) : ''
	const writeScopesText = input.writeScopes.length ? formatScopeList(input.writeScopes, 12) : ''
	const budgetLine = (() => {
		const b = input.budgets
		if (!b) return null
		const total = typeof b.maxStepsTotal === 'number' && Number.isFinite(b.maxStepsTotal) ? Math.floor(b.maxStepsTotal) : null
		return `Budget: maxAttempts=${Math.floor(b.maxAttempts)} · maxStepsPerAttempt=${Math.floor(b.maxStepsPerAttempt)}${total ? ` · maxStepsTotal=${total}` : ''}. If you cannot finish within budget, stop and ask the user to narrow scopes or split the instruction.`
	})()

	const mode = input.mode ?? 'compact'
	const commonTail = [
		input.contextPackText ? `Context pack:\n${input.contextPackText}` : null,
		`Tool groups: ${toolGroupsText}.`,
		input.toolIndexText ? `Tool index:\n${input.toolIndexText}` : null,
		readScopesText ? `Read scope (enforced, count=${input.readScopes.length}): ${readScopesText}.` : null,
		writeScopesText ? `Write scope (enforced, count=${input.writeScopes.length}): ${writeScopesText}.` : 'Write scope (enforced): (none).',
	]

	const compact = [
		'You are a spreadsheet agent operating on a Univer workbook.',
		'Rules: do not guess. Never invent sheet names. Always use fully-qualified A1 (Sheet1!A1:D4) using sheet names from get_sheets / allowed scopes.',
		'A1 ranges are inclusive. Prefer providing set_range_data values as a dense matrix matching rows×cols of the target A1 (best). If you provide a smaller dense matrix, only the top-left subrange will be written (tool returns a warning).',
		'Scope: NEVER read/write outside allowed scopes. If required, stop and ask the user to expand scope.',
		'Write permission: if writeScopes is empty, you MUST NOT write; ask the user to grant write scope.',
		'Contract limits: each write tool call consumes 1 change. Prefer batching writes with set_ranges_data (many updates in 1 change) to avoid hitting changes/ops limits.',
		'Efficiency: prefer batch tools (get_ranges_data/set_ranges_data) over many tiny calls; avoid scanning large ranges.',
		'After any write, verify by reading back the exact changed A1 ranges (or use write-tool readback).',
		'Finish: done=true only when verified; summary must include what changed + which A1 ranges were read to verify.',
		budgetLine,
		...commonTail,
	]

	if (mode === 'compact') return compact.filter(Boolean).join('\n')

	const full = [
		'You are a spreadsheet agent operating on a Univer workbook.',
		'Workflow: read -> write -> verify (read-after-write). Do not guess.',
		'Never invent sheet names. Always use fully-qualified A1 (Sheet1!A1:B10) with sheet names from get_sheets; if the sheet name contains spaces/symbols, quote it: \'Sheet 1\'!A1:B10.',
		'A1 ranges are inclusive. Example: Sheet1!A1:D4 covers 4 rows × 4 cols. Prefer set_range_data values to match the exact range size (rows × cols) with a dense matrix. If you provide a smaller dense matrix, only the top-left subrange will be written (tool returns a warning).',
		'Only use numeric indices where a tool explicitly requires them (e.g. insert/delete rows/columns, set_cell_dimensions). For cell ranges, use A1.',
		'Scope: NEVER read/write outside the allowed scopes. If the task requires out-of-scope access, stop and ask the user to expand scope.',
		'Contract limits: each write tool call consumes 1 change. Prefer batching writes with set_ranges_data (many updates in 1 change) to avoid hitting changes/ops limits.',
		'Efficiency: keep reads small and targeted; for scanning use search_cells then narrow reads. Avoid many tiny calls; aim to finish within ~12 tool calls per attempt.',
		'Write strategy: plan edits first, then apply the smallest number of writes. Prefer set_ranges_data for multiple patches; use fill_formula only for uniform formulas; otherwise set_range_data with a full per-cell matrix.',
		'Verification recipe after writes: re-read the exact changed A1 ranges (get_ranges_data). To reduce round-trips, you may use write-tool readback when available (set_range_data/set_ranges_data/auto_fill/fill_formula support readback) to read back updated ranges after writing in the same tool call. If formulas/formatting are involved, includeDisplay=true and spot-check both top-left and bottom-right cells of each changed region.',
		'High-risk operations: avoid structural tools (insert/delete rows/columns, merges) unless explicitly required by the instruction. Structural edits can shift cell addresses; verify carefully with targeted reads.',
		'Error recovery: when a tool error occurs, follow the Hint exactly; if sheet ids/names are uncertain, call get_sheets and retry with a valid sheet reference.',
		'Write permission: if writeScopes is empty, you MUST NOT write. If the instruction requires editing, stop and ask the user to grant write permission (set write scope).',
		'If feedback is provided: fix it first.',
		'Finish: done=true only when the instruction is satisfied AND verified by reads.',
		'When done=true, summary must be concise and include: what changed + which A1 ranges were read to verify.',
		budgetLine,
		'Output convention: reuse fully-qualified A1 outputs verbatim for follow-up reads/writes to avoid address mistakes.',
		...commonTail,
	]

	return full.filter(Boolean).join('\n')
}

function formatScopeList(scopes: readonly string[], maxItems: number) {
	const max = Math.max(1, Math.floor(maxItems))
	if (scopes.length <= max) return scopes.join(', ')
	const head = scopes.slice(0, max).join(', ')
	return `${head}, … (+${scopes.length - max})`
}
