import type { UniverPluginSpec } from '@pluxel/univer-headless/protocol'
import { isRecord } from '../shared'

function isPluginSpec(value: unknown): value is UniverPluginSpec {
	if (!isRecord(value)) return false
	if (value.kind !== 'univer-plugin') return false
	if (typeof value.id !== 'string') return false
	if (typeof value.plugin !== 'string') return false
	return true
}

export function parsePluginsSnapshot(payload: unknown): { plugins: UniverPluginSpec[] } | null {
	if (!isRecord(payload)) return null
	const plugins = payload.plugins
	if (!Array.isArray(plugins)) return null
	const out: UniverPluginSpec[] = []
	for (const p of plugins) {
		if (!isPluginSpec(p)) continue
		out.push(p)
	}
	return { plugins: out }
}

export function parsePluginsUpsert(payload: unknown): { plugin: UniverPluginSpec } | null {
	if (!isRecord(payload)) return null
	const plugin = payload.plugin
	if (!isPluginSpec(plugin)) return null
	return { plugin }
}

export function parsePluginsRemove(payload: unknown): { id: string } | null {
	if (!isRecord(payload)) return null
	const id = payload.id
	if (typeof id !== 'string') return null
	return { id }
}
