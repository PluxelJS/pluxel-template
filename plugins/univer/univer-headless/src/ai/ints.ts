export function clampInt(n: unknown, min: number, max: number): number {
	const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : min
	return Math.max(min, Math.min(max, v))
}

export function parseEnvInt(name: string): number | null {
	try {
		const raw = (process as any)?.env?.[name]
		if (!raw) return null
		const n = Number(raw)
		if (!Number.isFinite(n)) return null
		return Math.floor(n)
	} catch {
		return null
	}
}
