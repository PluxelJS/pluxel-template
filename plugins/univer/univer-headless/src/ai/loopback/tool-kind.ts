export type ToolKind = 'read' | 'write' | 'other'

export function classifyToolKind(name: string): ToolKind {
	const n = String(name ?? '').trim()
	if (!n) return 'other'

	if (n === 'univer.listSheets' || n === 'univer.readRangeDisplay') return 'read'
	if (n === 'univer.applyOpsV1' || n === 'univer.clearRange') return 'write'

	if (n.startsWith('get_')) return 'read'
	if (n.startsWith('search_')) return 'read'

	if (n.startsWith('set_')) return 'write'
	if (n.startsWith('auto_')) return 'write'
	if (n.startsWith('fill_')) return 'write'
	if (n.startsWith('create_')) return 'write'
	if (n.startsWith('rename_')) return 'write'
	if (n.startsWith('delete_')) return 'write'
	if (n.startsWith('activate_')) return 'write'
	if (n.startsWith('move_')) return 'write'
	if (n.startsWith('insert_')) return 'write'
	if (n.startsWith('format_')) return 'write'

	// Conservative fallback.
	return 'other'
}

