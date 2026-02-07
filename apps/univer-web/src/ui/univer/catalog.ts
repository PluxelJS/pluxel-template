export const SUPPORTED_UNIVER_PLUGIN_KEYS = ['watermark'] as const

export type SupportedUniverPluginKey = (typeof SUPPORTED_UNIVER_PLUGIN_KEYS)[number]

const SUPPORTED = new Set<string>(SUPPORTED_UNIVER_PLUGIN_KEYS)

export function isSupportedUniverPluginKey(key: string): key is SupportedUniverPluginKey {
	return SUPPORTED.has(key)
}

