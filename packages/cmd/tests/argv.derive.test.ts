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

describe('cmdkit: schema -> flags derivation', () => {
	it('fills FlagSpec.description from JSON Schema description/title', () => {
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

		const flags = exec.meta!.flags!
		expect(flags.find((f) => f.name === 'foo')?.description).toBe('Foo desc')
		expect(flags.find((f) => f.name === 'bar')?.description).toBe('Bar title')
		expect(flags.find((f) => f.name === 'foo')?.required).toBe(true)
	})
})

