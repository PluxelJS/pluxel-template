import { mergeWorksheetSnapshotWithDefault, type IWorkbookData } from '@univerjs/core'

import { isRecord } from '../shared'
import { detectLocale } from './locales'

export function normalizeWorkbookSnapshot(input: {
	workbookId: string
	workbookName: string
	snapshot?: unknown
}): IWorkbookData {
	const base: IWorkbookData = {
		id: input.workbookId,
		sheetOrder: [],
		name: input.workbookName,
		appVersion: '0.15.4',
		locale: detectLocale(),
		styles: {},
		sheets: {},
		resources: [],
	}

	const raw = isRecord(input.snapshot) ? (input.snapshot as Record<string, unknown>) : null
	const merged: Record<string, unknown> = raw ? { ...base, ...raw } : { ...base }
	merged.id = input.workbookId
	merged.name = input.workbookName

	const sheetsRaw = isRecord(merged.sheets) ? (merged.sheets as Record<string, unknown>) : Object.create(null)
	const orderRaw = Array.isArray(merged.sheetOrder) ? merged.sheetOrder : []
	const order = orderRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)

	const ensureSheet = (sheetId: string, sheet: unknown) => {
		const patch = isRecord(sheet) ? (sheet as Record<string, unknown>) : Object.create(null)
		return mergeWorksheetSnapshotWithDefault({ id: sheetId, ...(patch as any) } as any)
	}

	const nextSheets: Record<string, unknown> = Object.create(null)
	for (const [key, val] of Object.entries(sheetsRaw)) {
		if (!key) continue
		nextSheets[key] = ensureSheet(key, val)
	}

	const existingOrder = order.filter((id) => id in nextSheets)
	if (existingOrder.length === 0) {
		const sheetId = `${input.workbookId}-sheet-01`
		nextSheets[sheetId] = ensureSheet(sheetId, { id: sheetId, name: 'Sheet1' })
		merged.sheetOrder = [sheetId]
	} else {
		merged.sheetOrder = existingOrder
	}

	merged.sheets = nextSheets
	return merged as unknown as IWorkbookData
}
