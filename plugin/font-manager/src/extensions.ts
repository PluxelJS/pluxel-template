import type { FontManager } from './font-manager'
import { FontManagerRpc } from './rpc'

export function registerFontManagerExtensions(plugin: FontManager) {
	plugin.ctx.ext.ui.register({
		entryPath: './ui/index.tsx',
	})

	plugin.ctx.ext.rpc.registerExtension(() => new FontManagerRpc(plugin))
	plugin.ctx.ext.sse.registerExtension(() => plugin.createSseHandler())
}

