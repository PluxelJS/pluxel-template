import { BasePlugin, Plugin } from '@pluxel/hmr'

type HmrServiceLike = { entries?: unknown }
type WithHmrConfig = { config: { hmrService?: HmrServiceLike } }

function shouldRegisterHmrExtensions(ctx: WithHmrConfig): boolean {
	const entries = ctx.config.hmrService?.entries
	return Array.isArray(entries) && entries.length > 0
}

@Plugin({ name: 'UniverSheetsStudio', type: 'service' })
export class UniverSheetsStudio extends BasePlugin {
	override init() {
		if (!shouldRegisterHmrExtensions(this.ctx)) return
		this.ctx.ext.ui.register({ entryPath: './ui/index.tsx' })
	}
}

export default UniverSheetsStudio
export const plugins = [UniverSheetsStudio] as const
