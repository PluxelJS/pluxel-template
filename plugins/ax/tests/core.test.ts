import '@pluxel/hmr/services'
import { describe, expect, it } from 'bun:test'
import { BasePlugin, Plugin, withTestHost } from '@pluxel/core/test'

import type { AxFunction } from '@ax-llm/ax'

import { Ax, AxHub } from '../src'

const tool = (name: string): AxFunction =>
	({
		name,
		description: name,
		parameters: { type: 'object', properties: {} },
		func: async () => name,
	}) as any

@Plugin({ name: 'CallerA', type: 'service' })
class CallerA extends BasePlugin {
	constructor(private readonly ax: Ax) {
		super()
	}

	register(name: string) {
		this.ax.tool(tool(name))
	}
}

@Plugin({ name: 'CallerB', type: 'service' })
class CallerB extends BasePlugin {
	constructor(private readonly ax: Ax) {
		super()
	}

	register(name: string) {
		this.ax.tool(tool(name))
	}
}

describe('pluxel-plugin-ax: tool registry + caller ownership', () => {
	it('throws when registering a tool without caller context', async () => {
		await withTestHost(async (host) => {
			host.register(AxHub)
			await host.commitStrict()

			const ax = host.getOrThrow(Ax)
			expect(() => ax.tool(tool('x'))).toThrow(/caller context/i)
		})
	})

	it('prevents tool name conflicts across plugins', async () => {
		await withTestHost(async (host) => {
			host.registerAll(AxHub, CallerA, CallerB)
			await host.commitStrict()

			host.getOrThrow(CallerA).register('dup')
			expect(() => host.getOrThrow(CallerB).register('dup')).toThrow(/name conflict/i)
		})
	})

	it('unregisters tools when the owner plugin restarts', async () => {
		await withTestHost(async (host) => {
			host.registerAll(AxHub, CallerA)
			await host.commitStrict()

			host.getOrThrow(CallerA).register('t1')
			expect(host.getOrThrow(Ax).functions().map((f: any) => f.name)).toContain('t1')

			host.restart(CallerA)
			await host.commitStrict()

			expect(host.getOrThrow(Ax).functions().map((f: any) => f.name)).not.toContain('t1')
		})
	})
})
