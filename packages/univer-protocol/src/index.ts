export const UNIVER_PLUGINS_SSE_NS = 'univer:plugins' as const

/**
 * Serializable spec: Host/Service -> SSE -> Browser.
 *
 * Frontend bundles all supported Univer plugins in a compile-time catalog.
 * Runtime only sends: which plugin key + config.
 */
export type UniverConfiguredPlugin = Readonly<{
	id?: string
	plugin: string
	config?: unknown
}>

export type UniverPluginSpec = Readonly<{
	id: string
	kind: 'univer-plugin'
	plugin: string
	config?: unknown
}>

export type UniverPluginsSnapshotPayload = Readonly<{
	plugins: readonly UniverPluginSpec[]
}>

export type UniverPluginsUpsertPayload = Readonly<{
	plugin: UniverPluginSpec
}>

export type UniverPluginsRemovePayload = Readonly<{
	id: string
}>

