import type { AxFunction } from '@ax-llm/ax'

import type { McpContext } from './context'
import { createDataTools } from './data'
import { createSheetTools } from './sheets'
import { createStructureTools } from './structure'
import { createStyleTools } from './style'

export type McpToolGroup = 'core' | 'data' | 'sheet' | 'structure' | 'style'

const GROUP_TOOL_NAMES: Record<McpToolGroup, Set<string>> = {
	core: new Set(['set_range_data', 'get_range_data', 'search_cells']),
	data: new Set(['auto_fill']),
	sheet: new Set([
		'get_sheets',
		'get_active_unit_id',
		'activate_sheet',
		'create_sheet',
		'rename_sheet',
		'delete_sheet',
		'move_sheet',
		'set_sheet_display_status',
		'get_activity_status',
	]),
	structure: new Set([
		'insert_rows',
		'insert_columns',
		'delete_rows',
		'delete_columns',
		'set_cell_dimensions',
		'set_merge',
	]),
	style: new Set(['set_range_style', 'format_brush']),
}

function filterTools(tools: AxFunction[], names: Set<string>) {
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

export function listMcpToolNames(groups: readonly McpToolGroup[]): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	for (const g of groups) {
		for (const name of GROUP_TOOL_NAMES[g] ?? []) {
			if (seen.has(name)) continue
			seen.add(name)
			out.push(name)
		}
	}
	return out
}

export function createMcpTools(ctx: McpContext, groups: readonly McpToolGroup[]): AxFunction[] {
	const selected: AxFunction[] = []
	const groupSet = new Set(groups)

	if (groupSet.has('core') || groupSet.has('data')) {
		const data = createDataTools(ctx)
		if (groupSet.has('core')) selected.push(...filterTools(data, GROUP_TOOL_NAMES.core))
		if (groupSet.has('data')) selected.push(...filterTools(data, GROUP_TOOL_NAMES.data))
	}
	if (groupSet.has('sheet')) {
		const sheets = createSheetTools(ctx)
		selected.push(...filterTools(sheets, GROUP_TOOL_NAMES.sheet))
	}
	if (groupSet.has('structure')) {
		const structure = createStructureTools(ctx)
		selected.push(...filterTools(structure, GROUP_TOOL_NAMES.structure))
	}
	if (groupSet.has('style')) {
		const style = createStyleTools(ctx)
		selected.push(...filterTools(style, GROUP_TOOL_NAMES.style))
	}

	return dedupeTools(selected)
}
