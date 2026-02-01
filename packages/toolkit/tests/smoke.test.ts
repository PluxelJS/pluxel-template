import { describe, expect, it } from 'vitest'

describe('@pluxel/toolkit', () => {
	it('imports subpaths', async () => {
		const pacer = await import('@pluxel/toolkit/pacer')
		const cache = await import('@pluxel/toolkit/cache')
		const option = await import('@pluxel/toolkit/option')
		const id = await import('@pluxel/toolkit/id')
		const hash = await import('@pluxel/toolkit/hash')
		const ohash = await import('@pluxel/toolkit/ohash')
		const time = await import('@pluxel/toolkit/time')

		expect(typeof pacer).toBe('object')
		expect(typeof cache).toBe('object')
		expect(typeof option).toBe('object')
		expect(typeof id).toBe('object')
		expect(typeof hash).toBe('object')
		expect(typeof ohash).toBe('object')
		expect(typeof time).toBe('object')

		expect(typeof cache.LRUCache).toBe('function')
		expect(typeof cache.SieveCache).toBe('function')

		expect(typeof option.isNotNull).toBe('function')
		expect(typeof option.createOk).toBe('function')

		expect(typeof id.nanoid).toBe('function')
		expect(typeof hash.rapidhash).toBe('function')
		expect(hash.rapidHash64Hex('hello').length).toBe(16)
		expect(typeof ohash.hash).toBe('function')

		expect(time.parseDurationMs('1s')).toBe(1000)
	})
})
