import { describe, expect, it } from 'vitest'

import { CmdError, obj, Type } from '../src'
import { cmd, resolveMcpToolDef } from '../src/cmd'

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
			.input(obj({ msg: Type.String() }))
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
			.input(obj({}))
			.output(obj({ ok: Type.Boolean() }))
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
			.input(obj({}))
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

		expect(resolveMcpToolDef(meta, { locale: 'zh-CN' })).toMatchObject({
			name: 'echo',
			title: '复读',
			description: '复读一段消息',
		})
	})

	it('defaults MCP description from doc.description when omitted', () => {
		const exec = cmd('x')
			.doc({ description: 'Doc desc' })
			.input(obj({}))
			.mcp({ title: 'X' })
			.handle(() => 'ok')
			.build()

		expect(resolveMcpToolDef(exec.mcp!, {})).toMatchObject({
			name: 'x',
			title: 'X',
			description: 'Doc desc',
		})
	})

	it('supports mcp() with no args (defaults title/description)', () => {
		const exec = cmd('x')
			.doc({ description: 'Doc desc' })
			.input(obj({}))
			.mcp()
			.handle(() => 'ok')
			.build()

		expect(resolveMcpToolDef(exec.mcp!, {})).toMatchObject({
			name: 'x',
			title: 'x',
			description: 'Doc desc',
		})
	})

	it('throws when schema cannot be compiled', () => {
		const badSchema = { type: 'object', properties: {} } as any
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
