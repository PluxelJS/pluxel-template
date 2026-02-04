import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, withHost } from '@pluxel/test'

import { Cached, Kv, KvMemory } from '../src/index'

const sleep = async (ms: number) => await new Promise((r) => setTimeout(r, ms))

describe('pluxel-plugin-kv (Cached decorator)', () => {
	it('memoizes when ttlMs is omitted', async () => {
		await withHost(async (host) => {
			let calls = 0

			@Plugin({ name: 'Foo', type: 'service' })
			class Foo extends BasePlugin {
				constructor(private readonly kv: Kv) {
					super()
				}

				@Cached()
				async getUser(id: string) {
					calls++
					return { id, calls }
				}
			}

			host.add([KvMemory, Foo])
			await host.commit()

			const foo = host.require(Foo)
			expect(await foo.getUser('u1')).toEqual({ id: 'u1', calls: 1 })
			expect(await foo.getUser('u1')).toEqual({ id: 'u1', calls: 1 })
			expect(calls).toBe(1)
		})
	})

	it('respects ttlMs and refreshes after expiry (envelope-based, not backend TTL)', async () => {
		await withHost(async (host) => {
			let calls = 0

			@Plugin({ name: 'Foo', type: 'service' })
			class Foo extends BasePlugin {
				constructor(private readonly kv: Kv) {
					super()
				}

				@Cached({ ttlMs: 20 })
				async getUser(id: string) {
					calls++
					return { id, calls }
				}
			}

			host.add([KvMemory, Foo])
			await host.commit()

			const foo = host.require(Foo)
			expect(await foo.getUser('u1')).toEqual({ id: 'u1', calls: 1 })
			expect(await foo.getUser('u1')).toEqual({ id: 'u1', calls: 1 })
			await sleep(30)
			expect(await foo.getUser('u1')).toEqual({ id: 'u1', calls: 2 })
		})
	})
})
