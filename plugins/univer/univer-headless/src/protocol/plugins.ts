export const UNIVER_PLUGINS_SSE_NS = 'univer:plugins' as const

export type UniverPluginRegistration = Readonly<{
	id?: string
	key: string
	config?: unknown
}>

export type UniverPluginSpec = Readonly<{
	id: string
	key: string
	config?: unknown
}>

export type UniverPluginsSnapshotPayload = Readonly<{
	items: readonly UniverPluginSpec[]
}>

export type UniverPluginsUpsertPayload = Readonly<{
	item: UniverPluginSpec
}>

export type UniverPluginsRemovePayload = Readonly<{
	id: string
}>
