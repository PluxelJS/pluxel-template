import type {
	UniverToolGroup,
	UniverToolIndexMode,
	UniverToolName,
	UniverToolPreset,
	UniverToolSpec,
} from '../../protocol'

type McpToolCatalogEntry = Readonly<{
	name: UniverToolName
	description: string
	group: UniverToolGroup
}>

export const MCP_TOOL_CATALOG: ReadonlyArray<McpToolCatalogEntry> = [
	{ name: 'set_range_data', description: 'Set values in a cell range.', group: 'core' },
	{ name: 'get_range_data', description: 'Read raw values in a cell range.', group: 'core' },
	{ name: 'search_cells', description: 'Search for content in a cell range.', group: 'core' },
	{ name: 'auto_fill', description: 'Auto-fill target range by tiling source values.', group: 'data' },
	{ name: 'get_sheets', description: 'List all worksheets.', group: 'sheet' },
	{ name: 'get_active_unit_id', description: 'Get current workbook id and active sheet id.', group: 'sheet' },
	{ name: 'get_activity_status', description: 'Get workbook status and info.', group: 'sheet' },
	{ name: 'create_sheet', description: 'Create a new worksheet.', group: 'sheet' },
	{ name: 'rename_sheet', description: 'Rename an existing sheet.', group: 'sheet' },
	{ name: 'delete_sheet', description: 'Delete an existing worksheet.', group: 'sheet' },
	{ name: 'activate_sheet', description: 'Switch active worksheet.', group: 'sheet' },
	{ name: 'move_sheet', description: 'Move sheet to a new index.', group: 'sheet' },
	{ name: 'set_sheet_display_status', description: 'Show or hide a worksheet.', group: 'sheet' },
	{ name: 'insert_rows', description: 'Insert rows into a worksheet.', group: 'structure' },
	{ name: 'insert_columns', description: 'Insert columns into a worksheet.', group: 'structure' },
	{ name: 'delete_rows', description: 'Delete rows in a worksheet.', group: 'structure' },
	{ name: 'delete_columns', description: 'Delete columns in a worksheet.', group: 'structure' },
	{ name: 'set_cell_dimensions', description: 'Set row heights and column widths.', group: 'structure' },
	{ name: 'set_merge', description: 'Merge or unmerge a cell range.', group: 'structure' },
	{ name: 'set_range_style', description: 'Apply cell styling to a range.', group: 'style' },
	{ name: 'format_brush', description: 'Copy and apply cell formatting from source to target.', group: 'style' },
]

const TOOL_META = new Map<UniverToolName, McpToolCatalogEntry>(
	MCP_TOOL_CATALOG.map((entry) => [entry.name, entry]),
)

const GROUP_META: Record<
	UniverToolGroup,
	Readonly<{ label: string; description: string; keywords: readonly string[] }>
> = {
	core: {
		label: 'core',
		description: 'Read/write/search cell ranges.',
		keywords: ['read', 'write', 'search', 'lookup', 'find', 'get', 'set', '查询', '搜索', '读取', '写入'],
	},
	data: {
		label: 'data',
		description: 'Fill or replicate data patterns.',
		keywords: ['fill', 'autofill', '填充', '填满', 'auto fill'],
	},
	sheet: {
		label: 'sheet',
		description: 'Worksheet management.',
		keywords: ['sheet', 'worksheet', 'tab', '工作表', '表单', '新建表', '重命名', '删除表', '隐藏', '显示', '切换'],
	},
	structure: {
		label: 'structure',
		description: 'Row/column operations and merges.',
		keywords: ['row', 'rows', 'column', 'columns', '行', '列', '插入', '删除行', '删除列', '合并', 'merge', '宽度', '高度'],
	},
	style: {
		label: 'style',
		description: 'Cell styling and format brush.',
		keywords: ['format', 'style', 'color', 'font', 'bold', 'italic', 'underline', '对齐', '边框', '颜色', '字体', '样式'],
	},
}

export const MCP_TOOL_GROUP_PRIORITY: ReadonlyArray<UniverToolGroup> = ['core', 'data', 'sheet', 'structure', 'style']

export const MCP_TOOL_GROUPS = MCP_TOOL_GROUP_PRIORITY.map((id) => {
	const meta = GROUP_META[id]
	return {
		id,
		label: meta.label,
		description: meta.description,
		keywords: meta.keywords,
		tools: MCP_TOOL_CATALOG.filter((entry) => entry.group === id).map((entry) => entry.name),
	}
})

export const MCP_TOOL_PRESETS: ReadonlyArray<{
	id: UniverToolPreset
	label: string
	groups: readonly UniverToolGroup[]
}> = [
	{ id: 'core', label: 'core', groups: ['core'] },
	{ id: 'data', label: 'data', groups: ['core', 'data'] },
	{ id: 'sheet', label: 'sheet', groups: ['core', 'sheet'] },
	{ id: 'structure', label: 'structure', groups: ['core', 'structure'] },
	{ id: 'style', label: 'style', groups: ['core', 'style'] },
	{ id: 'all', label: 'all', groups: ['core', 'data', 'sheet', 'structure', 'style'] },
]

function normalizeGroups(list: readonly UniverToolGroup[]): UniverToolGroup[] {
	const out: UniverToolGroup[] = []
	const seen = new Set<UniverToolGroup>()
	for (const g of list) {
		if (seen.has(g)) continue
		seen.add(g)
		out.push(g)
	}
	return out
}

function sortGroupsByPriority(groups: readonly UniverToolGroup[]): UniverToolGroup[] {
	const set = new Set(groups)
	return MCP_TOOL_GROUP_PRIORITY.filter((g) => set.has(g))
}

export function getMcpToolMeta(name: UniverToolName): McpToolCatalogEntry {
	const entry = TOOL_META.get(name)
	if (!entry) throw new Error(`[univer] tool meta missing: ${name}`)
	return entry
}

export function getMcpToolDescription(name: UniverToolName): string {
	return getMcpToolMeta(name).description
}

export function getMcpGroupKeywords(group: UniverToolGroup): readonly string[] {
	return GROUP_META[group]?.keywords ?? []
}

export function listMcpToolNames(groups: readonly UniverToolGroup[]): UniverToolName[] {
	const out: UniverToolName[] = []
	const seen = new Set<UniverToolName>()
	const ordered = sortGroupsByPriority(normalizeGroups(groups))
	for (const g of ordered) {
		const names = MCP_TOOL_GROUPS.find((entry) => entry.id === g)?.tools ?? []
		for (const name of names) {
			if (seen.has(name)) continue
			seen.add(name)
			out.push(name)
		}
	}
	return out
}

export function listMcpToolSpecs(groups: readonly UniverToolGroup[]): UniverToolSpec[] {
	const out: UniverToolSpec[] = []
	const seen = new Set<UniverToolName>()
	const ordered = sortGroupsByPriority(normalizeGroups(groups))
	for (const g of ordered) {
		for (const entry of MCP_TOOL_CATALOG) {
			if (entry.group !== g) continue
			if (seen.has(entry.name)) continue
			seen.add(entry.name)
			out.push({ name: entry.name, description: entry.description })
		}
	}
	return out
}

export function resolvePresetGroups(preset?: UniverToolPreset): UniverToolGroup[] {
	if (!preset) return []
	const match = MCP_TOOL_PRESETS.find((p) => p.id === preset)
	return match ? [...match.groups] : []
}

export function buildMcpToolIndexText(
	groups: readonly UniverToolGroup[],
	opts?: { mode?: UniverToolIndexMode; includePresets?: boolean },
): string {
	const mode: UniverToolIndexMode = opts?.mode ?? 'tools'
	if (mode === 'none') return ''

	const ordered = sortGroupsByPriority(normalizeGroups(groups))
	if (!ordered.length) return ''

	if (mode === 'groups') return `groups: ${ordered.join(', ')}`

	const lines: string[] = ordered.map((g) => `${g}: ${listMcpToolNames([g]).join(', ')}`)
	if (opts?.includePresets) {
		const presetLine = MCP_TOOL_PRESETS.map((p) => `${p.id}=${p.groups.join('+')}`).join('; ')
		lines.push(`presets: ${presetLine}`)
	}
	return lines.join('\n')
}

export function getMcpToolNameSet(group: UniverToolGroup): ReadonlySet<string> {
	const names = MCP_TOOL_GROUPS.find((entry) => entry.id === group)?.tools ?? []
	return new Set(names)
}
