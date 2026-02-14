import { describe, expect, it } from 'vitest'

import { createUniverAiBridge } from '../src/ai/bridge'
import { attachSheetIds, buildSheetMaps, toScopes } from '../src/ai/loopback/scopes'

function makeSheet(sheetId: string, name: string) {
	return {
		getSheetId: () => sheetId,
		getName: () => name,
	}
}

describe('univer-headless: sheet enumeration (Map/iterable safe)', () => {
	it('lists sheets when workbook.getSheets returns a Map', () => {
		const s1 = makeSheet('s1', 'Sheet1')
		const s2 = makeSheet('s2', 'Sheet2')
		const wb = {
			getSheets: () => new Map([['s1', s1], ['s2', s2]]),
			getActiveSheet: () => s1,
		}
		const bridge = createUniverAiBridge(wb)
		const res = bridge.listSheets()
		expect(res.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet2'])

		const { sheetNameToId } = buildSheetMaps(bridge)
		const scopes = toScopes(['Sheet2!A1:B2'])
		attachSheetIds(scopes, sheetNameToId)
		expect(scopes[0]!.sheetId).toBe('s2')
	})

	it('lists sheets when workbook.getSheets returns an entries array', () => {
		const s1 = makeSheet('s1', 'Sheet1')
		const s2 = makeSheet('s2', 'Sheet2')
		const wb = {
			getSheets: () => [
				['s1', s1],
				['s2', s2],
			],
			getActiveSheet: () => s1,
		}
		const bridge = createUniverAiBridge(wb)
		const res = bridge.listSheets()
		expect(res.sheets.map((s) => s.sheetId)).toEqual(['s1', 's2'])
	})
})

