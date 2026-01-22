// Demo plugin: Ax integration (tool registry + cmdkit MCP bridge).
//
// This plugin intentionally does NOT call the model (requires Ax profile + API key).
// It only registers a cmdkit executable as an Ax function tool, so other plugins can reuse it.

import { BasePlugin, Plugin } from '@pluxel/hmr'
import * as v from 'valibot'

import { cmd } from '@pluxel/cmd'
import { Ax } from 'pluxel-plugin-ax'

@Plugin({ name: 'PluginAxDemo' })
export class PluginAxDemo extends BasePlugin {
	constructor(private readonly ax: Ax) {
		super()
	}

	override async init() {
		// A small tool callable by Ax agents:
		// - tool schema is derived from input schema (via cmdkit `.mcp(...)`)
		// - execution is just cmdkit `exec.exec(...)`
		const echo = cmd('ax.demo.echo')
			.input(v.object({ msg: v.string() }))
			.mcp({ title: 'Echo', description: 'Echo a message' })
			.handle(({ msg }) => ({ msg }))
			.build()

		this.ax.cmd(echo)
		this.ctx.logger.info('Ax demo tool registered (ax.demo.echo)')
	}
}

