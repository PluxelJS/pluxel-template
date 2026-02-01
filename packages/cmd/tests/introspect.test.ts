import { describe, expect, it } from 'vitest'

import { cmd, isExecutable } from '../src'

describe('cmdkit: introspection', () => {
	it('isExecutable() filters unknown values', () => {
		expect(isExecutable(null)).toBe(false)
		expect(isExecutable(undefined)).toBe(false)
		expect(isExecutable(1 as any)).toBe(false)
		expect(isExecutable({} as any)).toBe(false)
		expect(isExecutable({ id: 'x' } as any)).toBe(false)
		expect(isExecutable({ exec: async () => ({ ok: true }) } as any)).toBe(false)

		const exec = cmd('x').handle(() => 'ok').build()
		expect(isExecutable(exec)).toBe(true)
	})
})

