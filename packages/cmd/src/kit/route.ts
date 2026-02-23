export const splitTokens = (input: string) =>
	String(input ?? '')
		.trim()
		.split(/\s+/g)
		.map((t) => t.trim())
		.filter(Boolean)

export const validateTokens = (tokens: string[], label: string) => {
	if (!tokens.length) throw new Error(`[cmdkit] invalid ${label}: empty`)
	for (const t of tokens) {
		if (!t) throw new Error(`[cmdkit] invalid ${label}: empty token`)
		if (/\s/.test(t)) throw new Error(`[cmdkit] invalid ${label}: token must not contain whitespace: ${JSON.stringify(t)}`)
		if (t.includes('.')) throw new Error(`[cmdkit] invalid ${label}: "." is not allowed: ${tokens.join(' ')}`)
		if (t.includes('/')) throw new Error(`[cmdkit] invalid ${label}: "/" is not allowed: ${tokens.join(' ')}`)
		if (t.includes(':')) throw new Error(`[cmdkit] invalid ${label}: ":" is not allowed: ${tokens.join(' ')}`)
	}
}

export const normalizeRoute = (input: string, label: string): { tokens: string[]; trigger: string } => {
	const tokens = splitTokens(input)
	validateTokens(tokens, label)
	return { tokens, trigger: tokens.join(' ') }
}

export const startsWithTokens = (tokens: readonly string[], prefix: readonly string[]) => {
	if (prefix.length === 0) return true
	if (tokens.length < prefix.length) return false
	for (let i = 0; i < prefix.length; i++) if (tokens[i] !== prefix[i]) return false
	return true
}

export const applyPrefix = (prefixTokens: readonly string[], tokens: string[]) =>
	prefixTokens.length === 0 || startsWithTokens(tokens, prefixTokens) ? tokens : [...prefixTokens, ...tokens]

export const deriveGroupFromTokens = (tokens: readonly string[]) => (tokens.length >= 2 ? tokens[0] : undefined)

