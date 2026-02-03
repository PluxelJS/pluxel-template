import type { Context } from '@pluxel/hmr'

import type { AxHub } from './hub'
import { AxHubRpc } from './rpc'

export function registerAxHubExtensions(input: { ctx: Context; hub: AxHub }) {
	// `@pluxel/hmr/services` can be imported in tests to provide shared runtime services (vault/pluginData/etc),
	// but extension registration requires a real HMR host context (hmrService config with entries).
	const hmr = (input.ctx.config as any)?.hmrService as { entries?: unknown } | undefined
	if (!hmr || !Array.isArray(hmr.entries) || hmr.entries.length === 0) return

	input.ctx.ext.ui.register({ entryPath: './src/ui/index.tsx' })
	input.ctx.ext.rpc.registerExtension(() => new AxHubRpc(input.hub))
}
