import '@pluxel/hmr/services'
import { describe, expect, it } from 'vitest'
import { withHost } from '@pluxel/test'

import { LLM, LLMHub } from '../src'
import { createAxAIFromConnection } from '../src/adapters/ax'

describe('pluxel-plugin-llm-hub: profiles + routing + circuit breaker', () => {
	it('creates profiles, sets apiKey, and resolves AxAI', async () => {
		await withHost(async (host) => {
			host.add(LLMHub)
			await host.commit()

			const hub = host.require(LLMHub)
			const p = await hub.createProfile({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test', makeDefault: true })

			expect(p.isDefault).toBe(true)
			expect(p.hasApiKey).toBe(true)

			const ai = createAxAIFromConnection(await host.require(LLM).connection())
			expect(ai.getName().toLowerCase()).toBe('openai')
		})
	})

	it('resolves a generic connection()', async () => {
		await withHost(async (host) => {
			host.add(LLMHub)
			await host.commit()

			const hub = host.require(LLMHub)
			await hub.createProfile({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test', makeDefault: true })

			const conn = await host.require(LLM).connection()
			expect(conn.profile.provider).toBe('openai')
			expect(conn.profile.model).toBe('gpt-4o-mini')
			expect(typeof conn.apiKey).toBe('string')
			expect(typeof conn.fetch).toBe('function')
		})
	})

	it('allows creating a profile without apiKey and fails ai() until apiKey is set', async () => {
		await withHost(async (host) => {
			host.add(LLMHub)
			await host.commit()

			const hub = host.require(LLMHub)
			const p = await hub.createProfile({ provider: 'openai', makeDefault: true })
			expect(p.hasApiKey).toBe(false)

			await expect(host.require(LLM).connection()).rejects.toThrow(/missing apiKey/i)

			await hub.setApiKey(p.id, 'sk-test')
			const ai = createAxAIFromConnection(await host.require(LLM).connection())
			expect(ai.getName().toLowerCase()).toBe('openai')
		})
	})

	it('moves default away when the default profile is disabled', async () => {
		await withHost(async (host) => {
			host.add(LLMHub)
			await host.commit()

			const hub = host.require(LLMHub)
			const a = await hub.createProfile({ provider: 'openai', apiKey: 'sk-a', makeDefault: true })
			const b = await hub.createProfile({ provider: 'openai', apiKey: 'sk-b', makeDefault: false })

			await hub.setDefaultProfile(b.id)
			await hub.updateProfile(b.id, { enabled: false })

			const list = await hub.listProfiles()
			const pa = list.find((p) => p.id === a.id)!
			const pb = list.find((p) => p.id === b.id)!
			expect(pa.isDefault).toBe(true)
			expect(pb.isDefault).toBe(false)
			expect(pb.enabled).toBe(false)
		})
	})

	it('falls back by priority when the default profile circuit is open', async () => {
		await withHost(async (host) => {
			host.add(LLMHub)
			await host.commit()

			const hub = host.require(LLMHub)
			const a = await hub.createProfile({ provider: 'openai', apiKey: 'sk-a', makeDefault: true, priority: 0 })
			const b = await hub.createProfile({ provider: 'anthropic', apiKey: 'sk-b', makeDefault: false, priority: 10 })

			// Force the default profile circuit open in stored health.
			;(hub as any).profiles.updateOne(
				{ id: a.id },
				{ $set: { health: { consecutiveFailures: 3, openUntil: Date.now() + 60_000 }, updatedAt: Date.now() } },
			)

			const conn = await host.require(LLM).connection()
			expect(conn.profile.provider).toBe('anthropic')

			// Make sure the candidate wasn't silently changed.
			const list = await hub.listProfiles()
			const pa = list.find((p) => p.id === a.id)!
			const pb = list.find((p) => p.id === b.id)!
			expect(pa.isDefault).toBe(true)
			expect(pb.isDefault).toBe(false)
		})
	})

	it('allowCircuitOpen forces a request and can close the circuit on success', async () => {
		await withHost(async (host) => {
			host.add(LLMHub)
			await host.commit()

			const hub = host.require(LLMHub)
			const p = await hub.createProfile({ provider: 'openai', apiKey: 'sk-a', makeDefault: true })

			// Force circuit open in stored health.
			;(hub as any).profiles.updateOne(
				{ id: p.id },
				{ $set: { health: { consecutiveFailures: 3, openUntil: Date.now() + 60_000 }, updatedAt: Date.now() } },
			)

			const originalFetch = (globalThis as any).fetch
			;(globalThis as any).fetch = async () => ({ status: 200 } as any)
			try {
				const conn = await host.require(LLM).connection({ profileId: p.id, allowCircuitOpen: true })
				const res: any = await conn.fetch('https://example.com')
				expect(res.status).toBe(200)
			} finally {
				;(globalThis as any).fetch = originalFetch
			}

			const list = await hub.listProfiles()
			const latest = list.find((x) => x.id === p.id)!
			expect((latest as any).health?.openUntil).toBeUndefined()
			expect((latest as any).health?.consecutiveFailures ?? 0).toBe(0)
		})
	})

	it('resets failure streak after cooldown', async () => {
		await withHost(async (host) => {
			host.add(LLMHub)
			await host.commit()

			const hub = host.require(LLMHub)
			const p = await hub.createProfile({ provider: 'openai', apiKey: 'sk-a', makeDefault: true })

			// Simulate an old open circuit that has already cooled down.
			;(hub as any).profiles.updateOne(
				{ id: p.id },
				{ $set: { health: { consecutiveFailures: 3, openUntil: Date.now() - 1 }, updatedAt: Date.now() } },
			)

			const originalFetch = (globalThis as any).fetch
			;(globalThis as any).fetch = async () => ({ status: 500 } as any)
			try {
				const conn = await host.require(LLM).connection({ profileId: p.id })
				const res: any = await conn.fetch('https://example.com')
				expect(res.status).toBe(500)
			} finally {
				;(globalThis as any).fetch = originalFetch
			}

			const list = await hub.listProfiles()
			const latest = list.find((x) => x.id === p.id)!
			expect((latest as any).health?.openUntil).toBeUndefined()
			expect((latest as any).health?.consecutiveFailures ?? 0).toBe(1)
		})
	})

	it('supports priority-first selection mode via settings', async () => {
		await withHost(async (host) => {
			host.add(LLMHub)
			await host.commit()

			const hub = host.require(LLMHub)
			await hub.createProfile({ provider: 'openai', apiKey: 'sk-a', makeDefault: true, priority: 0 })
			await hub.createProfile({ provider: 'anthropic', apiKey: 'sk-b', makeDefault: false, priority: 100 })

			const updated = await hub.updateSettingsResult({ selection: { mode: 'priority-first', fallback: true } as any })
			expect(updated.ok).toBe(true)

			const conn = await host.require(LLM).connection()
			expect(conn.profile.provider).toBe('anthropic')
		})
	})
})
