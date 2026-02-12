import type { AxFunction } from '@ax-llm/ax'

import type { UniverToolGroup } from '../../protocol'
import { createDataTools } from './data'
import { createSheetTools } from './sheets'
import { createStructureTools } from './structure'
import { createStyleTools } from './style'
import {
	MCP_TOOL_GROUPS,
	MCP_TOOL_PRESETS,
	buildMcpToolIndexText,
	getMcpToolDescription,
	getMcpToolNameSet,
	listMcpToolNames,
	listMcpToolSpecs,
} from './catalog'
import type { McpContext } from './context'

export type McpToolGroup = UniverToolGroup
export { MCP_TOOL_GROUPS, MCP_TOOL_PRESETS, buildMcpToolIndexText, getMcpToolDescription, listMcpToolNames, listMcpToolSpecs }

function filterTools(tools: AxFunction[], names: ReadonlySet<string>) {
	return tools.filter((t) => names.has(String(t.name)))
}

function dedupeTools(tools: AxFunction[]): AxFunction[] {
	const out: AxFunction[] = []
	const seen = new Set<string>()
	for (const t of tools) {
		const name = String(t.name)
		if (seen.has(name)) continue
		seen.add(name)
		out.push(t)
	}
	return out
}

export function createMcpTools(ctx: McpContext, groups: readonly McpToolGroup[]): AxFunction[] {
	const selected: AxFunction[] = []
	const groupSet = new Set(groups)

	if (groupSet.has('core') || groupSet.has('data')) {
		const data = createDataTools(ctx)
		if (groupSet.has('core')) selected.push(...filterTools(data, getMcpToolNameSet('core')))
		if (groupSet.has('data')) selected.push(...filterTools(data, getMcpToolNameSet('data')))
	}
	if (groupSet.has('sheet')) {
		const sheets = createSheetTools(ctx)
		selected.push(...filterTools(sheets, getMcpToolNameSet('sheet')))
	}
	if (groupSet.has('structure')) {
		const structure = createStructureTools(ctx)
		selected.push(...filterTools(structure, getMcpToolNameSet('structure')))
	}
	if (groupSet.has('style')) {
		const style = createStyleTools(ctx)
		selected.push(...filterTools(style, getMcpToolNameSet('style')))
	}

	return dedupeTools(selected)
}
