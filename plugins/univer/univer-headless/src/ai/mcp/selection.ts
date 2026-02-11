import type { UniverToolGroup, UniverToolPolicy } from '../../protocol'
import { MCP_TOOL_GROUP_PRIORITY, getMcpGroupKeywords, resolvePresetGroups } from './catalog'

function normalizeGroups(list?: readonly UniverToolGroup[]): UniverToolGroup[] {
	if (!list?.length) return []
	const out: UniverToolGroup[] = []
	const seen = new Set<UniverToolGroup>()
	for (const g of list) {
		if (seen.has(g)) continue
		seen.add(g)
		out.push(g)
	}
	return out
}

function sortByPriority(groups: readonly UniverToolGroup[]): UniverToolGroup[] {
	const set = new Set(groups)
	return MCP_TOOL_GROUP_PRIORITY.filter((g) => set.has(g))
}

export function resolveMcpToolGroups(
	instruction: string,
	policy?: UniverToolPolicy,
): { groups: UniverToolGroup[]; reason: string } {
	const text = `${instruction ?? ''} ${policy?.goal ?? ''}`.toLowerCase()
	const selected = new Set<UniverToolGroup>()

	const presetGroups = resolvePresetGroups(policy?.preset)
	if (presetGroups.length) {
		for (const g of presetGroups) selected.add(g)
	} else {
		selected.add('core')
	}

	for (const g of MCP_TOOL_GROUP_PRIORITY) {
		const keywords = getMcpGroupKeywords(g)
		if (!keywords.length) continue
		if (keywords.some((k) => text.includes(k))) selected.add(g)
	}

	for (const g of normalizeGroups(policy?.prefer)) selected.add(g)

	const allow = new Set(normalizeGroups(policy?.allow))
	if (allow.size) {
		for (const g of [...selected]) {
			if (!allow.has(g) && g !== 'core') selected.delete(g)
		}
	}

	for (const g of normalizeGroups(policy?.exclude)) selected.delete(g)

	let groups = sortByPriority([...selected])
	const maxGroups =
		typeof policy?.maxGroups === 'number' && Number.isFinite(policy.maxGroups)
			? Math.max(1, Math.floor(policy.maxGroups))
			: groups.length
	if (groups.length > maxGroups) groups = groups.slice(0, maxGroups)

	if (!groups.includes('core')) groups = ['core', ...groups]

	const reasonParts: string[] = []
	if (policy?.preset) reasonParts.push(`preset:${policy.preset}`)
	else reasonParts.push('auto')
	if (policy?.goal) reasonParts.push(`goal:${policy.goal}`)
	return { groups, reason: reasonParts.join(';') }
}
