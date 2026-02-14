import { describe, expect, it } from 'vitest'

import { scopesForRequest } from '../src/ai/loopback/permissions'

describe('univer-headless: loopback permissions (scope matching)', () => {
	it('matches by sheetId first', () => {
		const scopes = [{ sheetId: 's1', sheetName: 'Sheet1' }, { sheetId: 's2', sheetName: 'Sheet2' }]
		const res = scopesForRequest(scopes, { sheetId: 's2' })
		expect(res).toHaveLength(1)
		expect(res[0]!.sheetName).toBe('Sheet2')
	})

	it('matches by sheetName when no id match', () => {
		const scopes = [{ sheetName: 'Sheet1' }, { sheetName: 'Sheet2' }]
		const res = scopesForRequest(scopes, { sheetName: 'Sheet2' })
		expect(res).toHaveLength(1)
		expect(res[0]!.sheetName).toBe('Sheet2')
	})

	it('can match name-only scopes from a sheetId via id->name map', () => {
		const scopes = [{ sheetName: 'Sheet1' }, { sheetName: 'Sheet2' }]
		const sheetIdToName = new Map([
			['id-1', 'Sheet1'],
			['id-2', 'Sheet2'],
		])
		const res = scopesForRequest(scopes, { sheetId: 'id-2', sheetIdToName })
		expect(res).toHaveLength(1)
		expect(res[0]!.sheetName).toBe('Sheet2')
	})

	it('only allows no-sheet scopes on default sheet', () => {
		const scopes = [{ sheetName: 'Sheet1' }, {}]
		const defaultOnly = scopesForRequest(scopes, { sheetName: 'Other', defaultSheetName: 'Sheet1' })
		expect(defaultOnly).toHaveLength(0)

		const okDefault = scopesForRequest(scopes, { defaultSheetName: 'Sheet1' })
		expect(okDefault).toHaveLength(1)
		expect(okDefault[0]!.sheetName).toBeUndefined()
	})
})
