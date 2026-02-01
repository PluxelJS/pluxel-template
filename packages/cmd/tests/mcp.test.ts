import { describe, expect, it } from 'vitest'

import type { AnyStdSchema } from '../src'
import { CmdError, cmd } from '../src'

const schemaFromJson = (opts: { input: Record<string, unknown>; output?: Record<string, unknown> }): AnyStdSchema =>
	({
		'~standard': {
			version: 1,
			vendor: 'test',
			types: { input: {} as any, output: {} as any },
			validate: (value: unknown) => ({ value }),
			jsonSchema: {
				input: () => opts.input,
				...(opts.output ? { output: () => opts.output } : {}),
			},
		},
	} as any)

describe('cmdkit: mcp()', () => {
	it('is opt-in (missing .mcp() => exec.mcp is undefined)', () => {
		const exec = cmd('x').handle(() => 'ok').build()
		expect(exec.mcp).toBeUndefined()
	})

	it('exposes exec.mcp with derived inputSchema', () => {
		const js = {
			type: 'object',
			properties: { msg: { type: 'string' } },
			required: ['msg'],
			additionalProperties: false,
		} as const

		const exec = cmd('echo')
			.input(schemaFromJson({ input: js as any }))
			.mcp({ title: 'Echo', description: 'Echo a message' })
			.handle(() => 'ok')
			.build()

		expect(exec.mcp).toMatchObject({
			name: 'echo',
			inputSchema: js,
		})
	})

	it('includes outputSchema when output is present and can be derived', () => {
		const inJs = { type: 'object', properties: {} }
		const outJs = { type: 'object', properties: { ok: { type: 'boolean' } } }

		const exec = cmd('x')
			.input(schemaFromJson({ input: inJs }))
			.output(schemaFromJson({ input: inJs, output: outJs }) as any)
			.mcp({ title: 'X', description: 'X', deriveOutputSchema: true })
			.handle(() => ({ ok: true }))
			.build()

		expect(exec.mcp).toMatchObject({
			name: 'x',
			inputSchema: inJs,
			outputSchema: outJs,
		})
	})

	it('supports i18n via function sources', () => {
		const exec = cmd('echo')
			.input(schemaFromJson({ input: { type: 'object', properties: {} } }))
			.mcp({
				title: (ctx) => (ctx.locale === 'zh-CN' ? '复读' : 'Echo'),
				description: (ctx) => (ctx.locale === 'zh-CN' ? '复读一段消息' : 'Echo a message'),
			})
			.handle(() => 'ok')
			.build()

		const meta = exec.mcp!
		expect(typeof meta.title).toBe('function')
		expect(typeof meta.description).toBe('function')
		expect((meta.title as any)({ locale: 'zh-CN' })).toBe('复读')
		expect((meta.description as any)({ locale: 'en-US' })).toBe('Echo a message')
	})

	it('throws when input JSON Schema cannot be derived and no override is provided', () => {
		const badSchema: AnyStdSchema =
			({
				'~standard': {
					version: 1,
					vendor: 'test',
					types: { input: {} as any, output: {} as any },
					validate: (value: unknown) => ({ value }),
				},
			} as any)

		try {
			cmd('bad')
				.input(badSchema)
				.mcp({ title: 'Bad', description: 'Bad' })
				.handle(() => 'ok')
				.build()
			throw new Error('expected build() to throw')
		} catch (e) {
			expect(e).toBeInstanceOf(CmdError)
			expect(e).toMatchObject({ code: 'E_INTERNAL' })
		}
	})
})
