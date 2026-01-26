import '@pluxel/hmr/services'
import { describe, expect, it } from 'bun:test'
import { BasePlugin, Plugin, withTestHost } from '@pluxel/core/test'

import type { AxAI } from '@ax-llm/ax'

import { Ax, AxHub } from '../src'
import { WithAxAI, WithAxTooling } from '../src/decorators'

@Plugin({ name: 'DecoratorsDemo', type: 'service' })
class DecoratorsDemo extends BasePlugin {
	// Required by pluginMethodDecorator(...) even if the method injects Ax via decorator.
	constructor(_ax: Ax) {
		super()
	}

	@WithAxAI()
	async provider(ai: AxAI) {
		return ai.getName().toLowerCase()
	}

	@WithAxTooling()
	async tooling({ ai, functions }: { ai: AxAI; functions: Array<{ name: string }> }) {
		return { provider: ai.getName().toLowerCase(), names: functions.map((f) => f.name).sort() }
	}
}

describe('pluxel-plugin-ax: decorators', () => {
	it('injects AxAI / tooling without ctor dependency', async () => {
		await withTestHost(async (host) => {
			host.registerAll(AxHub, DecoratorsDemo)
			await host.commitStrict()

			const hub = host.getOrThrow(AxHub)
			await hub.createProfile({ provider: 'openai', apiKey: 'sk-test', makeDefault: true })

			const demo = host.getOrThrow(DecoratorsDemo)
			expect(await demo.provider()).toBe('openai')

			const out = await demo.tooling()
			expect(out.provider).toBe('openai')
			expect(Array.isArray(out.names)).toBe(true)
		})
	})
})
