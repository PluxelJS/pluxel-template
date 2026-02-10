import { describe, expect, it } from 'vitest'

import { formatEtag, normalizeEtag } from '../src/workbooks.store'

describe('pluxel-plugin-univer-workbooks: smoke', () => {
	it('normalizes etag consistently', () => {
		expect(normalizeEtag(formatEtag('abc'))).toBe('abc')
		expect(normalizeEtag('"abc"')).toBe('abc')
		expect(normalizeEtag('W/"abc"')).toBe('abc')
	})
})
