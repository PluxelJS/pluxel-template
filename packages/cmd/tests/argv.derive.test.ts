import { describe, expect, it } from 'vitest'

import { cmd } from '../src/cmd'
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

	it('supports explicit long aliases via x-cmd-aliases', () => {
		const exec = cmd('x')
			.input(
				obj({
					userId: Type.String({ 'x-cmd-aliases': ['user', 'uid'] } as any),
				}),
			)
			.text()
			.handle((i: any) => i)
			.build()

		const user = exec.meta!.params!.find((p) => p.name === 'user-id')!
		expect(user.aliases).toContain('user')
		expect(user.aliases).toContain('uid')
	})

	it('lets explicit short flags win over auto-derived conflicts', async () => {
		const exec = cmd('x')
			.input(
				obj({
					alpha: Type.String({ 'x-cmd-short': 'a' } as any),
					age: Type.Number(),
				}),
			)
			.text()
			.handle((i: any) => i)
			.build()

		const alpha = exec.meta!.params!.find((p) => p.name === 'alpha')!
		const age = exec.meta!.params!.find((p) => p.name === 'age')!
		expect(alpha.short).toBe('a')
		expect(age.short).toBeUndefined()

		await expect(exec.execText!('x -a hi --age 3')).resolves.toEqual({
			ok: true,
			val: { alpha: 'hi', age: 3 },
			err: null,
		})
	})
})
