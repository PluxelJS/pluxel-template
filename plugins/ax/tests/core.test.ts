import '@pluxel/hmr/services'
import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, withHost } from '@pluxel/test'

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
		await withHost(async (host) => {
			host.add(AxHub)
			await host.commit()

			const ax = host.require(Ax)
			expect(() => ax.tool(tool('x'))).toThrow(/caller context/i)
		})
	})

	it('prevents tool name conflicts across plugins', async () => {
		await withHost(async (host) => {
			host.add([AxHub, CallerA, CallerB])
			await host.commit()

			host.require(CallerA).register('dup')
			expect(() => host.require(CallerB).register('dup')).toThrow(/name conflict/i)
		})
	})

	it('unregisters tools when the owner plugin restarts', async () => {
		await withHost(async (host) => {
			host.add([AxHub, CallerA])
			await host.commit()

			host.require(CallerA).register('t1')
			expect(host.require(Ax).functions().map((f: any) => f.name)).toContain('t1')

			host.restart(CallerA)
			await host.commit()

			expect(host.require(Ax).functions().map((f: any) => f.name)).not.toContain('t1')
		})
	})
})
