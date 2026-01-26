import { describe, expect, it } from 'bun:test'
import { withTestHost } from '@pluxel/core/test'

import { Kv, KvMemory, kvCached } from '../src/index'

const sleep = async (ms: number) => await new Promise((r) => setTimeout(r, ms))

describe('pluxel-plugin-kv (kvCached)', () => {
	it('dedupes concurrent cache misses (getFreshValue called once)', async () => {
		await withTestHost(async (host) => {
			host.register(KvMemory)
			await host.commitStrict()

			const store = host.getOrThrow(Kv).scope('Script')

			let calls = 0
			let resolve!: () => void
			const gate = new Promise<void>((r) => {
				resolve = r
			})

			const getFreshValue = async () => {
				calls++
				await gate
				return { ok: true, calls }
			}

			const a = kvCached({ store, key: 'k', ttlMs: 1000, getFreshValue })
			const b = kvCached({ store, key: 'k', ttlMs: 1000, getFreshValue })
			resolve()

			const [ra, rb] = await Promise.all([a, b])
			expect(ra).toEqual({ ok: true, calls: 1 })
			expect(rb).toEqual({ ok: true, calls: 1 })
			expect(calls).toBe(1)
		})
	})

	it('supports stale-while-revalidate (returns stale immediately, refreshes in background)', async () => {
		await withTestHost(async (host) => {
			host.register(KvMemory)
			await host.commitStrict()

			const store = host.getOrThrow(Kv).scope('Script')

			let calls = 0
			let resolveSecond: ((v: { n: number }) => void) | undefined

			const getFreshValue = async () => {
				calls++
				if (calls === 2) {
					return await new Promise<{ n: number }>((r) => {
						resolveSecond = r
					})
				}
				return { n: calls }
			}

			expect(await kvCached({ store, key: 'k', ttlMs: 30, staleTtlMs: 200, getFreshValue })).toEqual({ n: 1 })
			await sleep(40) // beyond fresh ttlMs, still within stale window

			// returns stale, starts refresh in background
			expect(await kvCached({ store, key: 'k', ttlMs: 30, staleTtlMs: 200, getFreshValue })).toEqual({ n: 1 })
			await sleep(0)
			expect(calls).toBe(2)

			resolveSecond?.({ n: 2 })
			await sleep(10)
			expect(await kvCached({ store, key: 'k', ttlMs: 30, staleTtlMs: 200, getFreshValue })).toEqual({ n: 2 })
		})
	})

	it('falls back to stale on error when enabled', async () => {
		await withTestHost(async (host) => {
			host.register(KvMemory)
			await host.commitStrict()

			const store = host.getOrThrow(Kv).scope('Script')
			expect(await kvCached({ store, key: 'k', ttlMs: 10, staleTtlMs: 20, getFreshValue: async () => 'v1' })).toBe(
				'v1',
			)

			await sleep(30) // beyond stale window => compute path (existing envelope passed)
			expect(
				await kvCached<string>({
					store,
					key: 'k',
					ttlMs: 10,
					staleTtlMs: 20,
					getFreshValue: async () => {
						throw new Error('boom')
					},
					fallbackToStaleOnError: true,
				}),
			).toBe('v1')
		})
	})
})
