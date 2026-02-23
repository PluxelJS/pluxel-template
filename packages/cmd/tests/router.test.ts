import { describe, expect, it } from 'vitest'

import { cmd } from '../src/cmd'
import { createRouter } from '../src/router'

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

		router.add(foo)
		router.add(foobar)

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
		router.add(a)
		expect(() => router.add(b)).toThrow()
	})

	it('supports remove(id) and allows re-add', async () => {
		const router = createRouter({ caseInsensitive: true })

		const a = cmd('a').text({ triggers: ['ping'] }).handle(() => 'a').build()
		router.add(a)
		await expect(router.dispatch('ping')).resolves.toEqual({ ok: true, val: 'a', err: null })

		router.remove('a')
		await expect(router.dispatch('ping')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_CMD_NOT_FOUND' } })

		const b = cmd('b').text({ triggers: ['ping'] }).handle(() => 'b').build()
		router.add(b)
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
		router.add(exec)

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
		router.add(exec)

		const m = router.match('FOO BAR')
		expect(m?.id).toBe('x')
		expect(m?.consumed).toBe(2)
		expect(m?.trigger).toBe('foo bar')
		await expect(router.dispatchTokens(m!.tokens)).resolves.toEqual({ ok: true, val: 'ok', err: null })

		await expect(router.dispatchMatch(m!)).resolves.toEqual({ ok: true, val: 'ok', err: null })
	})

	it('passes original text to execText(text) when available', async () => {
		const router = createRouter({ caseInsensitive: true })
		const exec = {
			id: 'x',
			meta: { triggers: ['say'] },
			execText: async (text: string) => ({ ok: true as const, val: text, err: null }),
		}
		router.add(exec as any)

		const input = 'SAY    --msg "hello world"'
		await expect(router.dispatch(input)).resolves.toEqual({ ok: true, val: input, err: null })

		const m = router.match(input)!
		await expect(router.dispatchTokens(m.tokens)).resolves.toEqual({ ok: true, val: m.tokens.map((t) => t.raw).join(' '), err: null })
	})

	it('reports tokenization errors as E_TEXT_PARSE', async () => {
		const router = createRouter({ caseInsensitive: true })
		const exec = cmd('a').text({ triggers: ['ping'] }).handle(() => 'a').build()
		router.add(exec)

		await expect(router.dispatch('ping "unterminated')).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_TEXT_PARSE' } })
	})

	it('guards against overly long text before tokenization', async () => {
		const router = createRouter({ maxTextLength: 8 })
		const exec = cmd('a').text({ triggers: ['ping'] }).handle(() => 'a').build()
		router.add(exec)

		await expect(router.dispatch('ping --x 123')).resolves.toMatchObject({ ok: false, err: { code: 'E_TEXT_PARSE', details: { reason: 'TEXT_TOO_LONG' } } })
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

	it('addMany() is atomic', () => {
		const router = createRouter({ caseInsensitive: true })
		const a = cmd('a').text({ triggers: ['x'] }).handle(() => 1).build()
		const b = cmd('b').text({ triggers: ['x'] }).handle(() => 2).build()

		expect(() => router.addMany([a, b])).toThrow()
		expect(router.list()).toEqual([])

		router.addMany([a])
		expect(router.list().map((e) => e.id)).toEqual(['a'])
	})

	it('setMany() is atomic', async () => {
		const router = createRouter({ caseInsensitive: true })
		const a1 = cmd('a').text({ triggers: ['ping'] }).handle(() => 'a1').build()
		const b = cmd('b').text({ triggers: ['pong'] }).handle(() => 'b').build()
		router.add(a1)
		router.add(b)

		const a2 = cmd('a').text({ triggers: ['pong'] }).handle(() => 'a2').build()
		expect(() => router.setMany([a2])).toThrow()

		await expect(router.dispatch('ping')).resolves.toEqual({ ok: true, val: 'a1', err: null })
		await expect(router.dispatch('pong')).resolves.toEqual({ ok: true, val: 'b', err: null })
	})
})
