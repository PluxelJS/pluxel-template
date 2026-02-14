import { describe, expect, it } from 'vitest'

import { buildSheetMaps } from '../src/ai/loopback/scopes'

describe('univer-headless: buildSheetMaps fallback', () => {
	it('seeds active sheet mapping when listSheets is empty', () => {
		const active = { getSheetId: () => 's1', getName: () => 'Sheet1' }
		const bridge = {
			workbook: { getActiveSheet: () => active },
			listSheets: () => ({ sheets: [] as any[] }),
		} as any

		const { sheetIdToName, sheetNameToId } = buildSheetMaps(bridge)
		expect(sheetIdToName.get('s1')).toBe('Sheet1')
		expect(sheetNameToId.get('Sheet1')).toBe('s1')
	})
})

