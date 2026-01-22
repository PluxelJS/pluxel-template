export type FlagSpec = {
	name: string
	alias?: string[]
	type: 'string' | 'number' | 'boolean'
	description?: string
	required?: boolean
	negate?: boolean
	default?: unknown
}

export type ParsedArgv = {
	flags: Record<string, unknown>
	unknownFlags: Record<string, Array<string | boolean>>
	_: string[] & { ['--']: string[] }
}

export interface ArgvAdapter {
	parse: (
		tokens: string[],
		cfg: {
			flags: FlagSpec[]
			allowUnknownFlags: boolean
			typeFlagOptions?: unknown
		},
	) => ParsedArgv

	/**
	 * Optional build-time hook to precompile a specialized parser for a fixed cfg.
	 * When provided, cmdkit calls this once in `build()` and reuses the returned
	 * function for every `execText()` call.
	 */
	precompile?: (cfg: {
		flags: FlagSpec[]
		allowUnknownFlags: boolean
		typeFlagOptions?: unknown
	}) => (tokens: string[]) => ParsedArgv
}

