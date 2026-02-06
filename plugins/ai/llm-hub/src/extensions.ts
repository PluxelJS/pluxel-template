import type { Context } from '@pluxel/hmr'

import type { LLMHub } from './hub'
import { LLMHubRpc } from './rpc'

function tryRegisterUi(ctx: Context): void {
	const ext = ctx.ext?.ui
	if (!ext) return

	try {
		ext.register({ entryPath: './ui/index.tsx' })
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (message.includes('无法定位插件目录')) {
			ctx.logger?.warn?.('LLM UI extension registration skipped', { error })
			return
		}
		throw error
	}
}

export function registerLLMHubExtensions(input: { ctx: Context; hub: LLMHub }) {
	// `@pluxel/hmr/services` can be imported in tests to provide shared runtime services (vault/pluginData/etc),
	// but extension registration requires a real HMR host context (hmrService config with entries).
	const hmr = (input.ctx.config as any)?.hmrService as { entries?: unknown } | undefined
	if (!hmr || !Array.isArray(hmr.entries) || hmr.entries.length === 0) return

	tryRegisterUi(input.ctx)
	input.ctx.ext?.rpc?.registerExtension(() => new LLMHubRpc(input.hub))
}
