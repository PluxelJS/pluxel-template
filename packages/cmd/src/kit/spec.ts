import type { CmdDoc } from '../doc'
import type { McpConfig } from '../mcp'
import type { CmdExt } from '../registry'

export type KitWithOptions = {
	/** Space-separated tokens prepended to command/op routes (subcommands). */
	prefix?: string
	/** Default group label used by help/UI (can be overridden per command). */
	group?: string
	/** Tags appended to all commands/ops registered by the derived kit. */
	tags?: readonly string[]
}

export type CommonSpec<Ext extends CmdExt = CmdExt> = {
	/** Whether this command/op should be installed. Default enabled. */
	enabled?: boolean
	/** Optional group label (used by help/UI). */
	group?: string
	/** Tags used by help filtering / grouping (implementation defined). */
	tags?: readonly string[]
	/** Human doc shared by text help + MCP tool metadata. */
	doc: CmdDoc
	/** Extension bag for downstream installers (permissions, rates, etc). */
	ext?: Ext
	/**
	 * Optional MCP tool config override.
	 *
	 * - `false`: do not expose as MCP tool.
	 * - object/undefined: MCP is enabled by default for non-internal commands/ops.
	 */
	mcp?: McpConfig | false
}

export type TextCommandSpec<Ext extends CmdExt = CmdExt> = CommonSpec<Ext> & {
	/** Primary command route string (space-separated tokens). Example: `"meme list"`, `"help"`. */
	name: string
	/** Extra routes (aliases). */
	aliases?: readonly string[]
	/** Optional tail placeholder (used for usage derivation). Example: `<query>` or `<expr>`. */
	tailUsage?: string
	/** Optional input keys populated by tail (used to hide redundant `--<key>` params from UI/help). */
	tailKeys?: readonly string[]
}

export type OpSpec<Ext extends CmdExt = CmdExt> = CommonSpec<Ext> & {
	/** Primary op/tool route string (space-separated tokens). Example: `"health"`, `"system health"`. */
	name: string
	/** Extra routes (aliases). */
	aliases?: readonly string[]
}
