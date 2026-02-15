import { CmdError } from './core'

export type TextToken = {
	/** Cooked token value (quotes removed, escapes resolved). */
	value: string
	/** Raw token substring as authored (no surrounding whitespace). */
	raw: string
	/** 0-based start index in the original input string. */
	start: number
	/** 0-based end index (exclusive) in the original input string. */
	end: number
}

export interface TextTokenizer {
	(input: string): TextToken[]
}

export const defaultTokenizer: TextTokenizer = (input) => {
	const out: TextToken[] = []

	let cur = ''
	let i = 0
	let quote: '"' | "'" | null = null

	let tokenStart = -1
	let tokenEnd = -1

	const flush = () => {
		if (tokenStart < 0) return
		const end = tokenEnd >= tokenStart ? tokenEnd : tokenStart
		out.push({
			value: cur,
			start: tokenStart,
			end,
			raw: input.slice(tokenStart, end),
		})
		cur = ''
		tokenStart = -1
		tokenEnd = -1
	}

	while (i < input.length) {
		const ch = input[i++]

		if (quote) {
			if (ch === '\\') {
				// Escape: include the escaped char in value, keep raw in span.
				if (i >= input.length) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Dangling escape' })
				cur += input[i++]
				tokenEnd = i
				continue
			}
			if (ch === quote) {
				quote = null
				tokenEnd = i
				continue
			}
			cur += ch
			tokenEnd = i
			continue
		}

		// Not in quote.
		if (ch === '"' || ch === "'") {
			if (tokenStart < 0) tokenStart = i - 1
			quote = ch
			tokenEnd = i
			continue
		}

		if (/\s/.test(ch)) {
			flush()
			continue
		}

		if (ch === '\\') {
			if (tokenStart < 0) tokenStart = i - 1
			if (i >= input.length) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Dangling escape' })
			cur += input[i++]
			tokenEnd = i
			continue
		}

		if (tokenStart < 0) tokenStart = i - 1
		cur += ch
		tokenEnd = i
	}

	if (quote) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Unterminated quote' })
	flush()
	return out
}
