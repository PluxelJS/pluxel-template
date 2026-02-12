import type { UniverAiContext, UniverAiReadRangeDisplayInput, UniverAiReadRangeDisplayResult } from '../../protocol'
import type { LoopLimits } from './limits'
import { matrixPreviewTSV } from './text'

export async function buildContextPackText(
	readRangeDisplay: (input: UniverAiReadRangeDisplayInput) => Promise<UniverAiReadRangeDisplayResult>,
	scopes: readonly string[],
	limits: Required<LoopLimits>,
	selections?: readonly UniverAiContext[],
): Promise<string> {
	const picked = scopes.filter(Boolean).slice(0, 4)
	if (!picked.length) return ''

	const selectionMap = new Map<string, UniverAiContext>()
	for (const s of selections ?? []) {
		const a1 = String(s?.selection?.a1 ?? '').trim()
		if (!a1) continue
		selectionMap.set(a1, s)
	}

	const lines: string[] = []
	for (const a1 of picked) {
		try {
			const sel = selectionMap.get(a1)
			if (sel?.selection?.display && Array.isArray(sel.selection.display)) {
				const values = sel.selection.display
				const rows = values.length
				const cols = Math.max(0, ...values.map((r) => (Array.isArray(r) ? r.length : 0)))
				lines.push(
					`- ${a1} (sheetId=${String(sel.selection.sheetId ?? '') || 'unknown'}, size=${rows}x${cols}${sel.selection.truncated ? ', truncated' : ''})`,
				)
				const preview = matrixPreviewTSV(values, { maxRows: 8, maxCols: 10, maxCellChars: 32 })
				if (preview) lines.push(preview)
				continue
			}

			const res = await readRangeDisplay({ a1, limits })
			const rows = res.values.length
			const cols = Math.max(0, ...res.values.map((r) => r.length))
			lines.push(`- ${a1} (sheetId=${res.sheetId}, size=${rows}x${cols}${res.truncated ? ', truncated' : ''})`)
			const preview = matrixPreviewTSV(res.values, { maxRows: 8, maxCols: 10, maxCellChars: 32 })
			if (preview) lines.push(preview)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			lines.push(`- ${a1} (read failed: ${msg})`)
		}
	}
	return lines.join('\n')
}

