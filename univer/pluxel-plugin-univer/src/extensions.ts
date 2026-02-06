import type { Context } from '@pluxel/hmr'

function tryRegisterUi(ctx: Context): (() => void) | null {
	const ext = ctx.ext?.ui
	if (!ext) return null

	try {
		return ext.register({ entryPath: './ui/index.tsx' })
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (message.includes('无法定位插件目录')) {
			ctx.logger?.warn?.('extension registration skipped', { error })
			return null
		}
		throw error
	}
}

export function registerUniverExtensions(ctx: Context) {
	const off = tryRegisterUi(ctx)
	if (off) ctx.effects.defer(off)
}

