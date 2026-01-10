import { describe, expect, it } from 'bun:test'
import { BasePlugin, Plugin, withTestHost } from '@pluxel/core/test'

import { Cached, Kv, KvMemory } from '../src/index'

const sleep = async (ms: number) => await new Promise((r) => setTimeout(r, ms))

describe('pluxel-plugin-kv (Cached decorator)', () => {
	it('memoizes when ttlMs is omitted', async () => {
		await withTestHost(async (host) => {
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

			host.registerAll(KvMemory, Foo)
			await host.commitStrict()

			const foo = host.getOrThrow(Foo)
			expect(await foo.getUser('u1')).toEqual({ id: 'u1', calls: 1 })
			expect(await foo.getUser('u1')).toEqual({ id: 'u1', calls: 1 })
			expect(calls).toBe(1)
		})
	})

	it('respects ttlMs and refreshes after expiry (envelope-based, not backend TTL)', async () => {
		await withTestHost(async (host) => {
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

			host.registerAll(KvMemory, Foo)
			await host.commitStrict()

			const foo = host.getOrThrow(Foo)
			expect(await foo.getUser('u1')).toEqual({ id: 'u1', calls: 1 })
			expect(await foo.getUser('u1')).toEqual({ id: 'u1', calls: 1 })
			await sleep(30)
			expect(await foo.getUser('u1')).toEqual({ id: 'u1', calls: 2 })
		})
	})
})
