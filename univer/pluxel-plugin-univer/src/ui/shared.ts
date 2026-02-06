export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function toEditorUrl(id: string) {
	return `/univer/workbooks/${encodeURIComponent(id)}`
}

export function parseWorkbookId(pathname: string): string | null {
	const p = pathname.split('?')[0]?.split('#')[0] ?? ''
	const prefix = '/univer/workbooks/'
	if (!p.startsWith(prefix)) return null
	const rest = p.slice(prefix.length)
	if (!rest) return null
	return decodeURIComponent(rest.split('/')[0] ?? '')
}

