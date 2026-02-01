import { describe, expect, it } from 'vitest'

import * as v from 'valibot'

import { CmdError, cmd } from '../src'

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

	it('rejects unknown flags by default', async () => {
		const exec = cmd('unknown')
			.input(v.object({ foo: v.string() }))
			.text()
			.handle((input) => input.foo)
			.build()

		await expect(exec.execText!('unknown --nope x --foo ok')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_ARGV_PARSE' } })
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

	it('supports custom triggers and positionals via map', async () => {
		const exec = cmd('echo')
			.input(v.object({ msg: v.string() }))
			.text({
				triggers: ['e'],
				map: (p) => ({ msg: String(p._[0] ?? '') }),
			})
			.handle((i) => i.msg)
			.build()

		await expect(exec.execText!('e hello')).resolves.toEqual({ ok: true, val: 'hello', err: null })
		await expect(exec.execText!('echo hello')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_ARGV_PARSE' } })
	})

	it('wraps argv parse errors as CmdError', async () => {
		const exec = cmd('bad')
			.text({
				flags: [],
				map: () => {
					throw new Error('bad map')
				},
			})
			.handle(() => 'ok')
			.build()

		const r = await exec.execText!('bad x')
		expect(r.ok).toBe(false)
		if (!r.ok) {
			expect(r.err).toBeInstanceOf(CmdError)
			expect(r.err).toMatchObject({ code: 'E_ARGV_PARSE' })
		}
	})

	it('accepts text(mapFn) sugar', async () => {
		const exec = cmd('echo')
			.input(v.object({ msg: v.string() }))
			.text((p) => ({ msg: String(p._[0] ?? '') }))
			.handle((i) => i.msg)
			.build()

		await expect(exec.execText!('echo hi')).resolves.toEqual({ ok: true, val: 'hi', err: null })
	})

	it('tokenizes quotes and escapes (default tokenizer)', async () => {
		const exec = cmd('echo')
			.input(v.object({ msg: v.string() }))
			.text({
				flags: [],
				map: (p) => ({ msg: String(p._[0] ?? '') }),
			})
			.handle((i) => i.msg)
			.build()

		await expect(exec.execText!('echo "hello world"')).resolves.toEqual({ ok: true, val: 'hello world', err: null })
		await expect(exec.execText!('echo hello\\ world')).resolves.toEqual({ ok: true, val: 'hello world', err: null })
		await expect(exec.execText!('echo "a\\\"b"')).resolves.toEqual({ ok: true, val: 'a\"b', err: null })
	})
})
