export type CmdDoc = {
	/**
	 * One-line summary, suitable for:
	 * - human help list
	 * - MCP/tool description
	 */
	description?: string

	/**
	 * Optional long-form doc (Markdown recommended).
	 * Use this as the single source of truth for both:
	 * - text command usage
	 * - MCP/tool call guidance
	 */
	details?: string

	/**
	 * Optional usage string (single-line recommended).
	 *
	 * Examples:
	 * - `echo <msg>`
	 * - `user create --email <email>`
	 */
	usage?: string

	/**
	 * Optional examples, as plain text.
	 *
	 * Upstream can render these into CLI help and/or tool docs.
	 */
	examples?: string[]
}

export type DocContext = {
	locale?: string
	[k: string]: unknown
}

export type DocProvider = (ctx: DocContext) => CmdDoc | undefined
export type CmdDocSource = CmdDoc | DocProvider

export type DocTextProvider = (ctx: DocContext) => string
export type DocTextSource = string | DocTextProvider

export const resolveDoc = (doc: CmdDocSource | undefined, ctx: DocContext): CmdDoc | undefined => {
	if (!doc) return undefined
	if (typeof doc === 'function') return doc(ctx)
	return doc
}

export const resolveText = (text: DocTextSource, ctx: DocContext): string => {
	if (typeof text === 'function') return text(ctx)
	return String(text)
}

export const mergeDocSources = (a: CmdDocSource | undefined, b: CmdDocSource): CmdDocSource => {
	if (!a) return b
	if (typeof a === 'function' && typeof b === 'function') {
		return (ctx) => ({ ...(a(ctx) ?? {}), ...(b(ctx) ?? {}) })
	}
	if (typeof a === 'function' && typeof b !== 'function') {
		return (ctx) => ({ ...(a(ctx) ?? {}), ...(b ?? {}) })
	}
	if (typeof a !== 'function' && typeof b === 'function') {
		return (ctx) => ({ ...(a ?? {}), ...(b(ctx) ?? {}) })
	}
	return { ...(a as CmdDoc), ...(b as CmdDoc) }
}
