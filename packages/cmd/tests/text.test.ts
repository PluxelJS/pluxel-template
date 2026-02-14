import { describe, expect, it } from 'vitest'

import * as v from 'valibot'
import { Runtime } from '@sinclair/parsebox'

import type { AnyStdSchema } from '../src'
import { cmd, textTail } from '../src'

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

describe('cmdkit: text()', () => {
	it('uses the final input schema even if text() is called before input()', async () => {
		const exec = cmd('late')
			.text()
			.input(v.object({ foo: v.string() }))
			.handle((i) => i.foo)
			.build()

		await expect(exec.execText!('late --foo ok')).resolves.toEqual({ ok: true, val: 'ok', err: null })
	})

	it('derives primitive flags from input schema and maps into input', async () => {
		const exec = cmd('flags')
			.input(v.object({ foo: v.string(), bar: v.optional(v.number()) }))
			.text()
			.handle((input) => input)
			.build()

		await expect(exec.execText!('flags --foo hi --bar 3')).resolves.toEqual({ ok: true, val: { foo: 'hi', bar: 3 }, err: null })
	})

	it('rejects unknown params', async () => {
		const exec = cmd('unknown')
			.input(v.object({ foo: v.string() }))
			.text()
			.handle((input) => input.foo)
			.build()

		await expect(exec.execText!('unknown --nope x --foo ok')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_TEXT_PARSE' } })
	})

	it('supports boolean negation via --no-<flag>', async () => {
		const exec = cmd('bool')
			.input(v.object({ enabled: v.optional(v.boolean(), true) }))
			.text()
			.handle((input) => input.enabled)
			.build()

		await expect(exec.execText!('bool')).resolves.toEqual({ ok: true, val: true, err: null })
		await expect(exec.execText!('bool --no-enabled')).resolves.toEqual({ ok: true, val: false, err: null })
	})

	it('supports custom triggers', async () => {
		const tail = textTail(new Runtime.Module({ Main: Runtime.Until(['\n'], (s) => ({ msg: s.trim() })) }), 'Main')
		const exec = cmd('echo')
			.input(v.object({ msg: v.string() }))
			.text({ triggers: ['e'], tail })
			.handle((i) => i.msg)
			.build()

		await expect(exec.execText!('e hello')).resolves.toEqual({ ok: true, val: 'hello', err: null })
		await expect(exec.execText!('echo hello')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_TEXT_PARSE' } })
	})

	it('parses tail via ParseBox (use `--` to pass dash-prefixed tail)', async () => {
		const tail = textTail(new Runtime.Module({ Main: Runtime.Until(['\n'], (s) => ({ msg: s.trim() })) }), 'Main')
		const exec = cmd('echo')
			.input(v.object({ msg: v.string() }))
			.text({ tail })
			.handle((i) => i.msg)
			.build()

		await expect(exec.execText!('echo hi')).resolves.toEqual({ ok: true, val: 'hi', err: null })
		await expect(exec.execText!('echo --foo')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_TEXT_PARSE' } })
		await expect(exec.execText!('echo -- --foo')).resolves.toEqual({ ok: true, val: '--foo', err: null })
	})

		it('tokenizes quotes and escapes in flag values (default tokenizer)', async () => {
			const exec = cmd('echo')
				.input(v.object({ msg: v.string() }))
				.text()
				.handle((i) => i.msg)
				.build()

			await expect(exec.execText!('echo --msg "hello world"')).resolves.toEqual({ ok: true, val: 'hello world', err: null })
			await expect(exec.execText!('echo --msg hello\\ world')).resolves.toEqual({ ok: true, val: 'hello world', err: null })
			await expect(exec.execText!('echo --msg "a\\\"b"')).resolves.toEqual({ ok: true, val: 'a"b', err: null })
		})

	it('accepts long aliases (camel/snake) and short flags when unique', async () => {
		const exec = cmd('x')
			.input(v.object({ userId: v.string(), force: v.optional(v.boolean()) }))
			.text()
			.handle((i) => i)
			.build()

		await expect(exec.execText!('x --user-id u1 --force')).resolves.toEqual({ ok: true, val: { userId: 'u1', force: true }, err: null })
		await expect(exec.execText!('x --userId u1 --force')).resolves.toEqual({ ok: true, val: { userId: 'u1', force: true }, err: null })
		await expect(exec.execText!('x --user_id u1 -f')).resolves.toEqual({ ok: true, val: { userId: 'u1', force: true }, err: null })
		await expect(exec.execText!('x -u u1 -f')).resolves.toEqual({ ok: true, val: { userId: 'u1', force: true }, err: null })
	})

	it('drops auto short flags on conflicts (strategy B)', async () => {
		const exec = cmd('x')
			.input(v.object({ foo: v.string(), file: v.string() }))
			.text()
			.handle((i) => i)
			.build()

		await expect(exec.execText!('x -f x --foo a --file b')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_TEXT_PARSE' } })
	})

	it('rejects canonical name collisions (no ambiguous flags)', () => {
		expect(() =>
			cmd('x')
				.input(
					schemaFromJson({
						type: 'object',
						properties: {
							fooBar: { type: 'string' },
							'foo-bar': { type: 'string' },
						},
						required: ['fooBar', 'foo-bar'],
					}),
				)
				.text()
				.handle((i: any) => i)
				.build(),
		).toThrow()
	})

	it('supports boolean short bundling (-abc)', async () => {
		const exec = cmd('x')
			.input(v.object({ alpha: v.optional(v.boolean()), beta: v.optional(v.boolean()), charlie: v.optional(v.boolean()) }))
			.text()
			.handle((i) => i)
			.build()

			await expect(exec.execText!('x -abc')).resolves.toEqual({
				ok: true,
				val: { alpha: true, beta: true, charlie: true },
				err: null,
			})
			await expect(exec.execText!('x -ABC')).resolves.toEqual({
				ok: true,
				val: { alpha: true, beta: true, charlie: true },
				err: null,
			})
	})

	it('allows explicit boolean values for short flags (-f false)', async () => {
		const exec = cmd('x')
			.input(v.object({ force: v.optional(v.boolean(), true) }))
			.text()
			.handle((i) => i.force)
			.build()

		await expect(exec.execText!('x -f')).resolves.toEqual({ ok: true, val: true, err: null })
		await expect(exec.execText!('x -f false')).resolves.toEqual({ ok: true, val: false, err: null })
		await expect(exec.execText!('x -f=0')).resolves.toEqual({ ok: true, val: false, err: null })
	})

	it('supports attached short values (-n10, -ufoo, -n-1)', async () => {
		const exec = cmd('x')
			.input(v.object({ num: v.number(), user: v.string() }))
			.text()
				.handle((i) => i)
				.build()

		await expect(exec.execText!('x -n10 -ufoo')).resolves.toEqual({ ok: true, val: { num: 10, user: 'foo' }, err: null })
		await expect(exec.execText!('x -n-1 -u--bar')).resolves.toEqual({ ok: true, val: { num: -1, user: '--bar' }, err: null })
		await expect(exec.execText!('x -N10 -Ufoo -u=bar')).resolves.toEqual({ ok: true, val: { num: 10, user: 'bar' }, err: null })
	})

	it('prevents mixed short bundles when not all are boolean', async () => {
		const exec = cmd('x')
			.input(v.object({ alpha: v.optional(v.boolean()), beta: v.optional(v.boolean()), name: v.string() }))
			.text()
			.handle((i) => i)
			.build()

		await expect(exec.execText!('x -abnX')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_TEXT_PARSE' } })
	})

	it('prevents keyed flags from appearing inside implicit ParseBox tail (use `--` for explicit tail)', async () => {
		const tail = textTail(new Runtime.Module({ Main: Runtime.Until(['\n'], (s) => ({ expr: s })) }), 'Main')
		const exec = cmd('where')
			.input(v.object({ user: v.string(), force: v.optional(v.boolean()), expr: v.string() }))
			.text({ tail })
			.handle((i) => i.expr)
			.build()

		await expect(exec.execText!('where --user u1 expr -f')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_TEXT_PARSE' } })
		await expect(exec.execText!('where --user u1 expr --force')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_TEXT_PARSE' } })
		await expect(exec.execText!('where --user u1 expr -u2')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_TEXT_PARSE' } })
		await expect(exec.execText!('where --user u1 -- expr -f')).resolves.toEqual({ ok: true, val: 'expr -f', err: null })
		await expect(exec.execText!('where --user u1 -- expr --force -u2')).resolves.toEqual({ ok: true, val: 'expr --force -u2', err: null })
	})

	it('enforces integer parsing when JSON Schema uses type: integer', async () => {
		const exec = cmd('x')
			.input(
				schemaFromJson({
					type: 'object',
					properties: { count: { type: 'integer' } },
					required: ['count'],
				}),
			)
			.text()
			.handle((i: any) => i.count)
			.build()

		await expect(exec.execText!('x --count 1')).resolves.toEqual({ ok: true, val: 1, err: null })
		await expect(exec.execText!('x --count 1.2')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_TEXT_PARSE' } })
	})

	it('maps remaining text into input fields via ParseBox tail', async () => {
		const tail = textTail(
			new Runtime.Module({
				Main: Runtime.Until(['\n'], (s) => ({ items: s.trim().length ? s.trim().split(/\s+/g).filter(Boolean) : [] })),
			}),
			'Main',
		)
		const exec = cmd('args')
			.input(v.object({ items: v.array(v.string()) }))
			.text({ tail })
			.handle((i) => i.items)
			.build()

		await expect(exec.execText!('args a b c')).resolves.toEqual({ ok: true, val: ['a', 'b', 'c'], err: null })
	})

	it('parses raw DSL tail into input fields (tail is text-only)', async () => {
		const tail = textTail(new Runtime.Module({ Main: Runtime.Until(['\n'], (s) => ({ expr: s })) }), 'Main')
		const exec = cmd('where')
			.input(v.object({ user: v.string(), expr: v.string() }))
			.text({ tail })
			.handle((i) => ({ user: i.user, raw: i.expr }))
			.build()

		await expect(exec.execText!('where --user u1 x:"y z" and k=1')).resolves.toEqual({
			ok: true,
			val: { user: 'u1', raw: 'x:"y z" and k=1' },
			err: null,
		})
	})
})
