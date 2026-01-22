import { describe, expect, it } from 'bun:test'

import { cmd, createRouter } from '../src'

describe('cmdkit: router', () => {
	it('prefers longest match', async () => {
		const router = createRouter({ caseInsensitive: true })

		const foo = cmd('foo')
			.text({ triggers: ['foo'] })
			.handle(() => 'foo')
			.build()
		const foobar = cmd('foobar')
			.text({ triggers: ['foo bar'] })
			.handle(() => 'foo bar')
			.build()

		router.add(foo, { triggers: foo.meta!.triggers })
		router.add(foobar, { triggers: foobar.meta!.triggers })

		await expect(router.dispatch('FOO BAR')).resolves.toEqual({ ok: true, val: 'foo bar', err: null })
	})

	it('throws E_CMD_NOT_FOUND for unknown', async () => {
		const router = createRouter()
		await expect(router.dispatch('missing')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_CMD_NOT_FOUND' } })
	})

	it('rejects conflicting names', () => {
		const router = createRouter()
		const a = cmd('a').text({ triggers: ['x'] }).handle(() => 1).build()
		const b = cmd('b').text({ triggers: ['x'] }).handle(() => 2).build()
		router.add(a, { triggers: a.meta!.triggers })
		expect(() => router.add(b, { triggers: b.meta!.triggers })).toThrow()
	})

	it('supports remove(id) and allows re-add', async () => {
		const router = createRouter({ caseInsensitive: true })

		const a = cmd('a').text({ triggers: ['ping'] }).handle(() => 'a').build()
		router.add(a, { triggers: a.meta!.triggers })
		await expect(router.dispatch('ping')).resolves.toEqual({ ok: true, val: 'a', err: null })

		router.remove('a')
		await expect(router.dispatch('ping')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_CMD_NOT_FOUND' } })

		const b = cmd('b').text({ triggers: ['ping'] }).handle(() => 'b').build()
		router.add(b, { triggers: b.meta!.triggers })
		await expect(router.dispatch('ping')).resolves.toEqual({ ok: true, val: 'b', err: null })
	})

	it('supports set(exec) upsert and list()/get()', async () => {
		const router = createRouter({ caseInsensitive: true })

		const a1 = cmd('a').text({ triggers: ['ping'] }).handle(() => 'a1').build()
		router.set(a1)
		expect(router.has('a')).toBe(true)
		expect(router.get('a')?.triggers).toEqual(['ping'])
		expect(router.list().map((x) => x.id)).toEqual(['a'])
		await expect(router.dispatch('ping')).resolves.toEqual({ ok: true, val: 'a1', err: null })

		const a2 = cmd('a').text({ triggers: ['ping'] }).handle(() => 'a2').build()
		router.set(a2)
		await expect(router.dispatch('ping')).resolves.toEqual({ ok: true, val: 'a2', err: null })
	})

	it('helpCommand() resolves by id or trigger (canonical + case-insensitive)', () => {
		const router = createRouter({ caseInsensitive: true })
		const exec = cmd('x').text({ triggers: ['foo bar'] }).handle(() => 'ok').build()
		router.add(exec, { triggers: exec.meta!.triggers })

		expect(router.helpCommand('x')?.id).toBe('x')
		expect(router.helpCommand('foo bar')?.id).toBe('x')
		expect(router.helpCommand('FOO BAR')?.id).toBe('x')
		expect(router.helpCommand('foo     bar')?.id).toBe('x')
	})

	it('set() is atomic: reject invalid upsert without removing old entry', async () => {
		const router = createRouter({ caseInsensitive: true })

		const a1 = cmd('a').text({ triggers: ['ping'] }).handle(() => 'a1').build()
		const b = cmd('b').text({ triggers: ['pong'] }).handle(() => 'b').build()
		router.add(a1)
		router.add(b)

		const a2 = cmd('a').text({ triggers: ['pong'] }).handle(() => 'a2').build()
		expect(() => router.set(a2)).toThrow()

		await expect(router.dispatch('ping')).resolves.toEqual({ ok: true, val: 'a1', err: null })
		await expect(router.dispatch('pong')).resolves.toEqual({ ok: true, val: 'b', err: null })
	})

	it('supports dispatchTokens() and match()', async () => {
		const router = createRouter({ caseInsensitive: true })
		const exec = cmd('x').text({ triggers: ['foo bar'] }).handle(() => 'ok').build()
		router.add(exec, { triggers: exec.meta!.triggers })

		const m = router.match('FOO BAR baz')
		expect(m?.id).toBe('x')
		expect(m?.consumed).toBe(2)
		expect(m?.trigger).toBe('foo bar')
		await expect(router.dispatchTokens(m!.tokens)).resolves.toEqual({ ok: true, val: 'ok', err: null })

		await expect(router.dispatchMatch(m!)).resolves.toEqual({ ok: true, val: 'ok', err: null })
	})

	it('provides diagnostics via check() (no mutation)', () => {
		const router = createRouter({ caseInsensitive: true })
		const a = cmd('a').text({ triggers: ['ping'] }).handle(() => 'a').build()
		router.add(a)

		const checked = router.check({ id: 'b', meta: { triggers: ['PING'] } })
		expect(checked.ok).toBe(false)
		if (!checked.ok) {
			expect(checked.issues.some((x) => x.kind === 'CONFLICTING_TRIGGER')).toBe(true)
		}
	})
})
