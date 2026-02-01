import { describe, expect, it } from 'vitest'

import type { AnyStdSchema } from '@pluxel/cmd'
import { cmd } from '@pluxel/cmd'

import { createCmdCatalog } from '../src'

const schemaFromJson = (inputJsonSchema: Record<string, unknown>): AnyStdSchema =>
	({
		'~standard': {
			version: 1,
			vendor: 'test',
			types: { input: {} as any, output: {} as any },
			validate: (value: unknown) => ({ value }),
			jsonSchema: {
				input: () => inputJsonSchema,
			},
		},
	}) as any

describe('cmd-catalog', () => {
	it('registerAll() discovers executables and composes router/tools/catalog', async () => {
		const ping = cmd('ping')
			.doc({ description: 'Ping' })
			.text()
			.handle(() => 'pong')
			.build()

		const echo = cmd('echo')
			.input(
				schemaFromJson({
					type: 'object',
					properties: { msg: { type: 'string' } },
					required: ['msg'],
				}),
			)
			.mcp({ title: 'Echo', description: (ctx: any) => (ctx.locale === 'zh-CN' ? '复读' : 'Echo') })
			.handle((i: any) => i.msg)
			.build()

		const catalog = createCmdCatalog({ nsKey: 'myplugin' })
		catalog.registerAll({ ping, echo, nope: 1 } as any)

		expect(catalog.list().map((x) => x.id)).toEqual(['echo', 'ping'])

		const r = catalog.router({ caseInsensitive: true })
		await expect(r.dispatch('PING')).resolves.toEqual({ ok: true, val: 'pong', err: null })

		const tools = catalog.mcpTools({ locale: 'zh-CN' })
		expect(tools.map((t) => t.name)).toEqual(['echo'])
		expect(tools[0]!.title).toBe('Echo')
		expect(tools[0]!.description).toBe('复读')
		expect(tools[0]!.inputSchema && typeof tools[0]!.inputSchema).toBe('object')

		const perms = catalog.permissionCatalog()
		expect(perms?.nsKey).toBe('myplugin')
		expect(perms?.decls.some((d) => d.kind === 'star' && d.local === 'cmd')).toBe(true)
		expect(perms?.decls.some((d) => d.kind === 'exact' && d.local === 'cmd.ping')).toBe(true)
		expect(perms?.decls.some((d) => d.kind === 'exact' && d.local === 'cmd.echo')).toBe(true)
	})
})
