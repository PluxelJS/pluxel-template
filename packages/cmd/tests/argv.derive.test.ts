import { describe, expect, it } from 'vitest'

import { cmd } from '../src'
import { obj, Type } from '../src'

describe('cmdkit: schema -> params derivation', () => {
	it('fills ParamSpec.description from JSON Schema description/title', () => {
		const exec = cmd('x')
			.input(
				obj({
					foo: Type.String({ description: 'Foo desc' }),
					bar: Type.Optional(Type.Number({ title: 'Bar title' })),
				}),
			)
			.text()
			.handle((i: any) => i)
			.build()

		const params = exec.meta!.params!
		expect(params.find((p) => p.name === 'foo')?.description).toBe('Foo desc')
		expect(params.find((p) => p.name === 'bar')?.description).toBe('Bar title')
		expect(params.find((p) => p.name === 'foo')?.required).toBe(true)
	})
})
