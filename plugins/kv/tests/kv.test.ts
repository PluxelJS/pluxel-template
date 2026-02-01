import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, withHost } from '@pluxel/test'

import { Kv, KvMemory } from '../src/index'

const sleep = async (ms: number) => await new Promise((r) => setTimeout(r, ms))

describe('pluxel-plugin-kv (KvMemory)', () => {
	it('throws when called without caller context (caller-scoped shortcuts)', async () => {
		await withHost(async (host) => {
			host.add(KvMemory)
			await host.commit()

			const kv = host.require(Kv)
			expect(() => kv.get('x')).toThrow(/caller context/i)
			expect(() => kv.set('x', 1)).toThrow(/caller context/i)
			expect(() => kv.has('x')).toThrow(/caller context/i)
		})
	})

	it('supports explicit scope without caller context', async () => {
		await withHost(async (host) => {
			host.add(KvMemory)
			await host.commit()

			const kv = host.require(Kv)
			const a = kv.scope('Script')
			const b = kv.scope('Script')
			expect(a).toBe(b)

			await a.set('k', { ok: true })
			expect<unknown>(await b.get('k')).toEqual({ ok: true })
		})
	})

	it('normalizes keys (slashes map to colons)', async () => {
		await withHost(async (host) => {
			host.add(KvMemory)
			await host.commit()

			const kv = host.require(Kv).scope('Script')
			await kv.set('a/b\\c', 123)
			expect<unknown>(await kv.get('a:b:c')).toBe(123)
		})
	})

	it('isolates keys by caller plugin id (no cross-plugin collisions)', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'A', type: 'service' })
			class A extends BasePlugin {
				constructor(private readonly kv: Kv) {
					super()
				}
				async setThenGet(value: string) {
					await this.kv.set('same', value)
					return await this.kv.get('same')
				}
			}

			@Plugin({ name: 'B', type: 'service' })
			class B extends BasePlugin {
				constructor(private readonly kv: Kv) {
					super()
				}
				async setThenGet(value: string) {
					await this.kv.set('same', value)
					return await this.kv.get('same')
				}
			}

			host.add([KvMemory, A, B])
			await host.commit()

			const a = host.require(A)
			const b = host.require(B)

			expect(await a.setThenGet('a')).toBe('a')
			expect(await b.setThenGet('b')).toBe('b')
			expect(await a.setThenGet('a2')).toBe('a2')
		})
	})

	it('supports TTL (note: second-granularity; ttlMs is rounded up)', async () => {
		await withHost(async (host) => {
			host.add(KvMemory)
			await host.commit()

			const kv = host.require(Kv).scope('Script')
			await kv.set('ttl', 'v', { ttlMs: 1 })
			expect<unknown>(await kv.get('ttl')).toBe('v')
			await sleep(1100)
			expect(await kv.get('ttl')).toBeNull()
		})
	})
})
