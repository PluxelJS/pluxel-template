import type { Schema } from './core'
import { CmdError, toJsonSchema } from './core'
import type { DocContext, DocTextSource } from './doc'
import { resolveText } from './doc'
import { isNonEmptyString } from './internal/strings'

export type McpConfig = {
	/**
	 * Tool name. Default: `id`.
	 *
	 * Note: keep it stable; upstream should decide how/where to register MCP tools.
	 */
	name?: string

	/**
	 * Human-friendly title (supports i18n via function).
	 * Some MCP registries/UI can display it; core treats it as metadata.
	 *
	 * Default: `id`.
	 */
	title?: DocTextSource

	/**
	 * One-line summary (supports i18n via function).
	 * This is the canonical MCP tool `description`.
	 *
	 * Default (when omitted): `doc.description` if available, otherwise `title`/`id`.
	 */
	description?: DocTextSource

		/**
		 * Optional JSON Schema override for MCP.
		 *
		 * If omitted, @pluxel/cmd uses the input TypeBox schema (JSON-serializable view).
		 */
		inputSchema?: Record<string, unknown>

		/**
		 * Optional output JSON Schema for MCP (structured outputs).
		 *
		 * If provided, @pluxel/cmd uses it as-is.
		 */
		outputSchema?: Record<string, unknown>

		/**
		 * Whether to derive `outputSchema` from the cmd output schema (when present).
		 *
		 * Default: false (explicit opt-in to avoid accidentally exposing internal output structure).
		 */
		deriveOutputSchema?: boolean
}

export type McpMeta = {
	name: string
	title: DocTextSource
	description: DocTextSource
	inputSchema: Record<string, unknown>
	outputSchema?: Record<string, unknown>
}

export type McpToolDef = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	outputSchema?: Record<string, unknown>
}

export const resolveMcpToolDef = (meta: McpMeta, ctx: DocContext): McpToolDef => ({
	name: meta.name,
	title: resolveText(meta.title, ctx),
	description: resolveText(meta.description, ctx),
	inputSchema: meta.inputSchema,
	...(meta.outputSchema ? { outputSchema: meta.outputSchema } : {}),
})

export const compileMcpMeta = (id: string, input: Schema, output: Schema | undefined, cfg: McpConfig): McpMeta => {
	if (typeof cfg.title === 'string' && !isNonEmptyString(cfg.title)) {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'mcp(): title must be a non-empty string' })
	}
	if (typeof cfg.description === 'string' && !isNonEmptyString(cfg.description)) {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'mcp(): description must be a non-empty string' })
	}

	const name = isNonEmptyString(cfg.name) ? cfg.name.trim() : id
	if (!isNonEmptyString(name)) {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'mcp(): invalid name' })
	}

	const title: DocTextSource = cfg.title ?? id
	const description: DocTextSource = cfg.description ?? cfg.title ?? id

	const inputSchema = cfg.inputSchema ?? toJsonSchema(input)
	const outputSchema = cfg.outputSchema ?? (cfg.deriveOutputSchema && output ? toJsonSchema(output) : undefined)

	return { name, title, description, inputSchema, ...(outputSchema ? { outputSchema } : {}) }
}
