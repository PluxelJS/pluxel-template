import type { UniverPluginSpec } from '@pluxel/univer-headless/protocol'
import { isRecord } from '../shared'

function isPluginSpec(value: unknown): value is UniverPluginSpec {
	if (!isRecord(value)) return false
	if (typeof value.id !== 'string') return false
	if (typeof value.key !== 'string') return false
	return true
}

export function parsePluginsSnapshot(payload: unknown): { items: UniverPluginSpec[] } | null {
	if (!isRecord(payload)) return null
	const items = payload.items
	if (!Array.isArray(items)) return null
	const out: UniverPluginSpec[] = []
	for (const p of items) {
		if (!isPluginSpec(p)) continue
		out.push(p)
	}
	return { items: out }
}

export function parsePluginsUpsert(payload: unknown): { item: UniverPluginSpec } | null {
	if (!isRecord(payload)) return null
	const item = payload.item
	if (!isPluginSpec(item)) return null
	return { item }
}

export function parsePluginsRemove(payload: unknown): { id: string } | null {
	if (!isRecord(payload)) return null
	const id = payload.id
	if (typeof id !== 'string') return null
	return { id }
}
