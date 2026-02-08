import type { UniverAiContext } from 'pluxel-plugin-univer-ai'

export type UniverAiToonSelection = {
	id: string
	sheetId: string | null
	a1: string
	range: { startRow: number; startCol: number; endRow: number; endCol: number }
	values: string[][]
	truncated?: boolean
	orig?: { startRow: number; startCol: number; endRow: number; endCol: number; rows: number; cols: number }
	limits?: { maxRows: number; maxCols: number }
}

export type UniverAiToonContext = {
	kind: 'pluxel.univer.selectionContext'
	schema: 1
	workbookId: string
	currentId: string
	selections: UniverAiToonSelection[]
}

function toStringMatrix(input: unknown): string[][] {
	if (!Array.isArray(input)) return []
	return input.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []))
}

export function toonSelectionId(ctx: Pick<UniverAiContext, 'sheetId' | 'range'>): string {
	const sheetId = ctx.sheetId ?? 'sheet'
	const r = ctx.range
	if (!r) return `${sheetId}:range:unknown`
	return `${sheetId}:${r.startRow}:${r.startCol}-${r.endRow}:${r.endCol}`
}

export function toToonSelection(ctx: UniverAiContext): UniverAiToonSelection {
	const range =
		ctx.range ??
		({
			startRow: 0,
			startCol: 0,
			endRow: 0,
			endCol: 0,
		} as const)
	const meta = (ctx.meta as any) ?? null
	return {
		id: toonSelectionId(ctx),
		sheetId: ctx.sheetId ?? null,
		a1: String(ctx.a1 ?? ''),
		range,
		values: toStringMatrix(ctx.displayValues),
		truncated: Boolean(meta?.truncated),
		orig: meta?.orig,
		limits: meta?.limits,
	}
}

export function buildToonContext(input: {
	workbookId: string
	current: UniverAiContext
	extras?: readonly UniverAiContext[]
}): UniverAiToonContext {
	const extras = input.extras ?? []
	const map = new Map<string, UniverAiContext>()

	const push = (ctx: UniverAiContext) => {
		const id = toonSelectionId(ctx)
		if (!map.has(id)) map.set(id, ctx)
	}

	push(input.current)
	for (const ctx of extras) push(ctx)

	const selections = Array.from(map.values()).map(toToonSelection)
	const currentId = toonSelectionId(input.current)
	return {
		kind: 'pluxel.univer.selectionContext',
		schema: 1,
		workbookId: input.workbookId,
		currentId,
		selections,
	}
}
