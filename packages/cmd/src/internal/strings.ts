export const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

export const uniqueStrings = (xs: readonly string[]) => {
	const out: string[] = []
	const seen = new Set<string>()
	for (const x of xs) {
		const s = String(x).trim()
		if (!s) continue
		if (seen.has(s)) continue
		seen.add(s)
		out.push(s)
	}
	return out
}

export const splitSpace = (input: string) =>
	input
		.trim()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean)

