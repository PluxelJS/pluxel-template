import { describe, expect, it } from 'bun:test'
import { BasePlugin, Plugin, withTestHost } from '@pluxel/core/test'

import { isRateLimitError, KvMemory, RateGuard, Rates } from '../src/index.ts'

const sleep = async (ms: number) => await new Promise((r) => setTimeout(r, ms))

describe('pluxel-plugin-kv (Rates)', () => {
	it('cooldown blocks and then allows after ttl', async () => {
		await withTestHost(async (host) => {
			@Plugin({ name: 'Foo', type: 'service' })
			class Foo extends BasePlugin {
				constructor(private readonly rates: Rates) {
					super()
				}

				async login(userId: string) {
					return await this.rates.cooldown(['login', userId], 30)
				}
			}

			host.registerAll(KvMemory, Rates, Foo)
			host.setConfig('Rates', { config: {} })
			await host.commitStrict()

			const foo = host.getOrThrow(Foo)
			expect(await foo.login('u1')).toEqual({ ok: true })

			const blocked = await foo.login('u1')
			expect(blocked.ok).toBe(false)
			if (!blocked.ok) expect(blocked.retryAfterMs).toBeGreaterThan(0)

			await sleep(40)
			expect(await foo.login('u1')).toEqual({ ok: true })
		})
	})

	it('fixedWindow enforces limit within the period', async () => {
		await withTestHost(async (host) => {
			@Plugin({ name: 'Foo', type: 'service' })
			class Foo extends BasePlugin {
				constructor(private readonly rates: Rates) {
					super()
				}
				async hit(userId: string) {
					return await this.rates.fixedWindow(['hit', userId], 60, 2)
				}
			}

			host.registerAll(KvMemory, Rates, Foo)
			host.setConfig('Rates', { config: {} })
			await host.commitStrict()

			const foo = host.getOrThrow(Foo)
			expect(await foo.hit('u1')).toEqual({ ok: true, remaining: 1 })
			expect(await foo.hit('u1')).toEqual({ ok: true, remaining: 0 })

			const blocked = await foo.hit('u1')
			expect(blocked.ok).toBe(false)
			if (!blocked.ok) expect(blocked.retryAfterMs).toBeGreaterThan(0)
		})
	})

	it('RateGuard decorator throws RateLimitError when blocked', async () => {
		await withTestHost(async (host) => {
			@Plugin({ name: 'Foo', type: 'service' })
			class Foo extends BasePlugin {
				constructor(private readonly rates: Rates) {
					super()
				}

				@RateGuard({
					rule: { type: 'cooldown', ttlMs: 1000 },
					parts: (_self, [userId]) => ['login', userId],
				})
				async login(userId: string) {
					return { ok: true, userId }
				}
			}

			host.registerAll(KvMemory, Rates, Foo)
			host.setConfig('Rates', { config: {} })
			await host.commitStrict()

			const foo = host.getOrThrow(Foo)
			expect(await foo.login('u1')).toEqual({ ok: true, userId: 'u1' })

			try {
				await foo.login('u1')
				throw new Error('expected to be rate-limited')
			} catch (e) {
				expect(isRateLimitError(e)).toBe(true)
				if (isRateLimitError(e)) {
					expect(e.source).toBe('kv')
					expect(e.rule.type).toBe('cooldown')
					expect(e.method).toBe('login')
					expect(e.retryAfterMs).toBeGreaterThan(0)
				}
			}
		})
	})
})

