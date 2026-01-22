import type { AnyStdSchema } from './core'
import { CmdError, getInputJsonSchema } from './core'
import type { DocTextSource } from './doc'
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
	 */
	title: DocTextSource

	/**
	 * One-line summary (supports i18n via function).
	 * This is the canonical MCP tool `description`.
	 */
	description: DocTextSource

	/**
	 * Optional JSON Schema override for MCP.
	 *
	 * If omitted, cmdkit derives it from the input Standard Schema at build-time.
	 */
	inputSchema?: Record<string, unknown>
}

export type McpMeta = {
	name: string
	title: DocTextSource
	description: DocTextSource
	inputSchema: Record<string, unknown>
}

export const compileMcpMeta = (id: string, input: AnyStdSchema, cfg: McpConfig): McpMeta => {
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

	const inputSchema = cfg.inputSchema ?? getInputJsonSchema(input)
	if (!inputSchema) {
		throw new CmdError('E_INTERNAL', 'Internal error', {
			message: 'mcp(): failed to derive JSON Schema from input schema (provide mcp.inputSchema override)',
		})
	}

	return { name, title: cfg.title, description: cfg.description, inputSchema }
}

