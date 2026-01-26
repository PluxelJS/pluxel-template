const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
}

export interface ParseDurationOptions {
	defaultUnit?: keyof typeof UNIT_MS
}

export function parseDurationMs(
	input: string | number,
	options: ParseDurationOptions = {},
): number {
	if (typeof input === 'number') return input
	const text = input.trim()
	if (text === '') throw new Error('parseDurationMs: empty input')

	const match = /^([+-]?\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i.exec(text)
	if (!match) throw new Error(`parseDurationMs: invalid duration "${input}"`)

	const value = Number(match[1])
	if (!Number.isFinite(value)) throw new Error(`parseDurationMs: invalid number "${match[1]}"`)

	const unitRaw = (match[2] ?? options.defaultUnit ?? 'ms').toLowerCase()
	const unit = UNIT_MS[unitRaw]
	if (!unit) throw new Error(`parseDurationMs: unsupported unit "${unitRaw}"`)

	return value * unit
}

export function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms)) return String(ms)
	const abs = Math.abs(ms)
	const sign = ms < 0 ? '-' : ''

	if (abs % UNIT_MS.d === 0) return `${sign}${abs / UNIT_MS.d}d`
	if (abs % UNIT_MS.h === 0) return `${sign}${abs / UNIT_MS.h}h`
	if (abs % UNIT_MS.m === 0) return `${sign}${abs / UNIT_MS.m}m`
	if (abs % UNIT_MS.s === 0) return `${sign}${abs / UNIT_MS.s}s`
	return `${ms}ms`
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
