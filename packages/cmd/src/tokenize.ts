export interface TextTokenizer {
	(input: string): string[]
}

export const defaultTokenizer: TextTokenizer = (input) => {
	const out: string[] = []
	let cur = ''
	let i = 0
	let quote: '"' | "'" | null = null
	while (i < input.length) {
		const ch = input[i++]
		if (quote) {
			if (ch === '\\') {
				if (i < input.length) cur += input[i++]
				continue
			}
			if (ch === quote) {
				quote = null
				continue
			}
			cur += ch
		} else {
			if (ch === '"' || ch === "'") {
				quote = ch
				continue
			}
			if (/\s/.test(ch)) {
				if (cur) {
					out.push(cur)
					cur = ''
				}
				continue
			}
			if (ch === '\\') {
				if (i < input.length) cur += input[i++]
				continue
			}
			cur += ch
		}
	}
	if (cur) out.push(cur)
	return out
}

