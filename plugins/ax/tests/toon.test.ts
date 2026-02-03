import { describe, expect, it } from 'vitest'

import { decodeToon, encodeToon, formatStructured } from '../src/toon'

describe('pluxel-plugin-ax/toon', () => {
	it('roundtrips encode/decode', () => {
		const input = {
			ok: true,
			name: 'demo',
			list: [
				{ id: 1, a: 'x', b: 2 },
				{ id: 2, a: 'y', b: 3 },
			],
		}

		const text = encodeToon(input)
		const out = decodeToon(text)
		expect(out).toEqual(input)
	})

	it('formats json/toon with contentType', () => {
		const value = [{ id: 1, a: 'x' }]
		const json = formatStructured(value, { format: 'json', jsonSpaces: 2 })
		expect(json.format).toBe('json')
		expect(json.contentType).toMatch(/application\/json/i)
		expect(typeof json.text).toBe('string')

		const toon = formatStructured(value, { format: 'toon' })
		expect(toon.format).toBe('toon')
		expect(toon.contentType).toMatch(/text\/toon/i)
		expect(typeof toon.text).toBe('string')
	})
})

