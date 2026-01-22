import { describe, expect, it } from 'bun:test'

import * as v from 'valibot'

import type { McpExecutable } from '@pluxel/cmd'
import { cmd } from '@pluxel/cmd'

import { cmdExecutableToAxFunction } from '../src/cmdkit'

describe('pluxel-plugin-ax: cmdkit bridge', () => {
	it('maps cmdkit mcp metadata into an Ax function', async () => {
		const exec = cmd('echo')
			.input(v.object({ msg: v.string() }))
			.mcp({ title: 'Echo', description: 'Echo a message' })
			.handle(({ msg }) => msg)
			.build() as unknown as McpExecutable<any, any>

		const fn: any = cmdExecutableToAxFunction(exec)
		expect(fn.name).toBe('echo')
		expect(fn.description).toBe('Echo a message')
		expect(typeof fn.func).toBe('function')

		const out = await fn.func({ msg: 'hi' })
		expect(out).toBe('hi')
	})
})

