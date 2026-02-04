import '@pluxel/hmr/services'
import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, withHost } from '@pluxel/test'

import { Ax, AxHub } from '../src'

@Plugin({ name: 'ToolOwner', type: 'service' })
class ToolOwner extends BasePlugin {
	constructor(private readonly ax: Ax) {
		super()
	}

	registerTool(name: string) {
		this.ax.tool({ name, description: name, parameters: { type: 'object', properties: {} }, func: async () => name } as any)
	}
}

describe('pluxel-plugin-ax: profiles + vault + default selection', () => {
	it('creates profiles, sets apiKey, and resolves ai()', async () => {
		await withHost(async (host) => {
			host.add(AxHub)
			await host.commit()

			const hub = host.require(AxHub)
			const p = await hub.createProfile({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test', makeDefault: true })

			expect(p.isDefault).toBe(true)
			expect(p.hasApiKey).toBe(true)

			const ai = await host.require(Ax).ai()
			expect(ai.getName().toLowerCase()).toBe('openai')
		})
	})

	it('allows creating a profile without apiKey and fails ai() until apiKey is set', async () => {
		await withHost(async (host) => {
			host.add(AxHub)
			await host.commit()

			const hub = host.require(AxHub)
			const p = await hub.createProfile({ provider: 'openai', makeDefault: true })
			expect(p.hasApiKey).toBe(false)

			await expect(host.require(Ax).ai()).rejects.toThrow(/missing apiKey/i)

			await hub.setApiKey(p.id, 'sk-test')
			const ai = await host.require(Ax).ai()
			expect(ai.getName().toLowerCase()).toBe('openai')
		})
	})

	it('moves default away when the default profile is disabled', async () => {
		await withHost(async (host) => {
			host.add(AxHub)
			await host.commit()

			const hub = host.require(AxHub)
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

	it('tooling() rejects extra function name conflicts', async () => {
		await withHost(async (host) => {
			host.add([AxHub, ToolOwner])
			await host.commit()

			const hub = host.require(AxHub)
			await hub.createProfile({ provider: 'openai', apiKey: 'sk-test', makeDefault: true })

			host.require(ToolOwner).registerTool('dup')

			await expect(
				host.require(Ax).tooling({
					functions: [{ name: 'dup', description: 'dup', parameters: { type: 'object' }, func: async () => 'x' } as any],
				}),
			).rejects.toThrow(/name conflict/i)
		})
	})
})
