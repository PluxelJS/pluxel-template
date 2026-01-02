// packages/hmr/tests/plugins/PluginStatusBadge.ts
// 示例：简单的状态徽章插件（RPC + SSE + PluginInfo UI）

import { BasePlugin, Plugin } from '@pluxel/hmr'
import { RpcTarget } from '@pluxel/hmr/capnweb'
import type { SseChannel } from '@pluxel/hmr/services'

export type PluginStatusBadgeSsePayload =
	| { type: 'ready'; counter: number }
	| { type: 'counter'; counter: number; at: number }

@Plugin({ name: 'PluginStatusBadge', type: 'event' })
export class PluginStatusBadge extends BasePlugin {
	private counter = 0
	private channels = new Set<SseChannel>()

	override async init() {
		this.ctx.ext.ui.register({ entryPath: './PluginStatusBadge/ui/index.tsx' })
		this.ctx.ext.rpc.registerExtension(() => new PluginStatusBadgeRpc(this))
		this.ctx.ext.sse.registerExtension(() => this.attachSse())

		const timer = setInterval(() => {
			this.counter++
			this.broadcast({ type: 'counter', counter: this.counter, at: Date.now() })
		}, 1000)

		this.ctx.scope.collectEffect(() => {
			clearInterval(timer)
		})

		this.ctx.logger.info('[PluginStatusBadge] Started')
	}

	getCounter() {
		return this.counter
	}

	private attachSse() {
		return (channel: SseChannel) => {
			this.channels.add(channel)
			channel.emit('ready', { type: 'ready', counter: this.counter })

			channel.onAbort(() => {
				this.channels.delete(channel)
			})

			return () => {
				this.channels.delete(channel)
			}
		}
	}

	private broadcast(payload: PluginStatusBadgeSsePayload) {
		for (const ch of this.channels) {
			try {
				ch.emit(payload.type, payload as any)
			} catch {}
		}
	}
}

export class PluginStatusBadgeRpc extends RpcTarget {
	constructor(private readonly plugin: PluginStatusBadge) {
		super()
	}

	counter() {
		return { counter: this.plugin.getCounter() }
	}
}

declare module '@pluxel/hmr/web' {
	namespace UI {
		interface rpc {
			PluginStatusBadge: PluginStatusBadgeRpc
		}

		interface sse {
			PluginStatusBadge: PluginStatusBadgeSsePayload
		}
	}
}

