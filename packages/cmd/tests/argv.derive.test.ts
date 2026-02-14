import { describe, expect, it } from 'vitest'

import type { AnyStdSchema } from '../src'
import { cmd } from '../src'

const schemaFromJson = (inputJsonSchema: Record<string, unknown>): AnyStdSchema =>
	({
		'~standard': {
			version: 1,
			vendor: 'test',
			types: { input: {} as any, output: {} as any },
			validate: (value: unknown) => ({ value }),
			jsonSchema: {
				input: () => inputJsonSchema,
			},
		},
	} as any)

describe('cmdkit: schema -> params derivation', () => {
	it('fills ParamSpec.description from JSON Schema description/title', () => {
		const exec = cmd('x')
			.input(
				schemaFromJson({
					type: 'object',
					properties: {
						foo: { type: 'string', description: 'Foo desc' },
						bar: { type: 'number', title: 'Bar title' },
					},
					required: ['foo'],
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
