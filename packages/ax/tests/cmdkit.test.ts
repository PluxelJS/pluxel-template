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

	it('propagates trace/session ids from Ax extra into cmdkit ExecCtx.meta', async () => {
		let seenCtx: any
		const exec: McpExecutable<any, any> = {
			mcp: { name: 'tool', title: 'tool', description: 'tool', inputSchema: { type: 'object' } as any } as any,
			exec: async (_args: any, ctx?: any) => {
				seenCtx = ctx
				return { ok: true as const, val: 'ok' }
			},
		} as any

		const fn: any = cmdExecutableToAxFunction(exec)
		await fn.func({}, { sessionId: 's1', traceId: 't1' })
		expect(seenCtx).toEqual({ meta: { sessionId: 's1', traceId: 't1' } })
	})

	it('returns a structured error when executable throws', async () => {
		const exec: McpExecutable<any, any> = {
			mcp: { name: 'boom', title: 'boom', description: 'boom', inputSchema: { type: 'object' } as any } as any,
			exec: async () => {
				throw new Error('boom')
			},
		} as any

		const fn: any = cmdExecutableToAxFunction(exec)
		const out = await fn.func({})
		expect(out).toEqual({ error: { code: 'INTERNAL', message: 'boom' } })
	})
})
