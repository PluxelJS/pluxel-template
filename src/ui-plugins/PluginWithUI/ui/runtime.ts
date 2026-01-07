import type { GlobalExtensionContext, PluginExtensionContext } from '@pluxel/hmr/web'
import { useExtensionContext } from '@pluxel/hmr/web'
import { useMemo } from 'react'

export function useGlobalRuntime(): Pick<GlobalExtensionContext, 'runningPluginsReady'> {
	const { runningPluginsReady } = useExtensionContext('global')
	return useMemo(() => ({ runningPluginsReady }), [runningPluginsReady])
}

export type PluginWithUIRuntime = Readonly<{
	pluginName: string
	ui: PluginExtensionContext['services']['hmr']['ui']['PluginWithUI']
	sse: PluginExtensionContext['services']['hmr']['sse']
}>

export function usePluginWithUIRuntime(): PluginWithUIRuntime {
	const { pluginName, services } = useExtensionContext('plugin')
	const hmr = services.hmr
	return useMemo(
		() => ({
			pluginName,
			ui: hmr.ui.PluginWithUI,
			// Use the shared host SSE connection to avoid exhausting browser connection limits.
			sse: hmr.sse,
		}),
		[pluginName, hmr],
	)
}

export function usePluginDashboardHref(): string {
	const { pluginName } = usePluginWithUIRuntime()
	return useMemo(() => `/plugins/${encodeURIComponent(pluginName)}/dashboard`, [pluginName])
}
