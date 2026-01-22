import type { Flags, TypeFlag, TypeFlagOptions } from 'type-flag'
import { typeFlag } from 'type-flag'

import { CmdError } from '../core'
import { uniqueStrings } from '../internal/strings'

import type { ArgvAdapter, FlagSpec, ParsedArgv } from './types'

const isValidType = (t: FlagSpec['type']) => t === 'string' || t === 'number' || t === 'boolean'

const compileTypeFlagSchemas = (specs: readonly FlagSpec[]): {
	schemas: Flags
	keyToLogical: Record<string, string>
	negateTokenToLogical: Record<string, string>
} => {
	const schemas: Flags = {}
	const keyToLogical: Record<string, string> = {}
	const negateTokenToLogical: Record<string, string> = {}

	for (const f of specs) {
		const logical = String(f.name).trim()
		if (!logical) continue
		if (!isValidType(f.type)) continue

		// type-flag does not allow 1-char long flag names; use `x_` with alias `x`.
		const key = logical.length === 1 ? `${logical}_` : logical
		const aliasList = uniqueStrings([...(f.alias ?? []), ...(logical.length === 1 ? [logical] : [])])
		const alias = aliasList.find((a) => a.length === 1)

		const baseType = f.type === 'string' ? String : f.type === 'number' ? Number : Boolean
		const schema =
			f.default !== undefined
				? ({ type: baseType, ...(alias ? { alias } : {}), default: f.default } as any)
				: (alias ? ({ type: baseType, alias } as any) : (baseType as any))

		schemas[key] = schema
		keyToLogical[key] = logical

		if (f.negate) negateTokenToLogical[`--no-${logical}`] = logical
	}

	return { schemas, keyToLogical, negateTokenToLogical }
}

const preprocessNegates = (tokens: readonly string[], negateTokenToLogical: Record<string, string>) => {
	if (!tokens.length) return { tokens: [] as string[], forced: {} as Record<string, boolean> }
	const forced: Record<string, boolean> = {}
	let changed = false
	const out: string[] = []
	for (const t of tokens) {
		const logical = negateTokenToLogical[t]
		if (logical) {
			forced[logical] = false
			changed = true
		} else {
			out.push(t)
		}
	}
	return { tokens: changed ? out : (tokens as string[]), forced }
}

export function createTypeFlagAdapter(): ArgvAdapter {
	const precompile: NonNullable<ArgvAdapter['precompile']> = (cfg) => {
		const flags = cfg.flags ?? []
		const allowUnknownFlags = cfg.allowUnknownFlags ?? false
		const compiled = compileTypeFlagSchemas(flags)
		const required = flags
			.filter((f) => !!f.required)
			.map((f) => String(f.name).trim())
			.filter(Boolean)

		return (tokens: string[]) => {
			const pre = preprocessNegates(tokens, compiled.negateTokenToLogical)

			let parsed: TypeFlag<Flags>
			try {
				parsed = typeFlag(compiled.schemas, pre.tokens, cfg.typeFlagOptions as TypeFlagOptions | undefined) as any
			} catch (e) {
				throw new CmdError('E_ARGV_PARSE', 'Invalid arguments', {
					message: (e as any)?.message ?? 'Failed to parse argv',
					cause: e,
				})
			}

			if (!allowUnknownFlags && Object.keys(parsed.unknownFlags ?? {}).length > 0) {
				throw new CmdError('E_ARGV_PARSE', 'Invalid arguments', {
					message: 'Unknown flags',
					details: { unknownFlags: parsed.unknownFlags },
				})
			}

			const outFlags: Record<string, unknown> = {}
			for (const [key, value] of Object.entries(parsed.flags as any)) {
				const logical = compiled.keyToLogical[key] ?? key
				outFlags[logical] = value
			}
			for (const [logical, v] of Object.entries(pre.forced)) outFlags[logical] = v

			for (const logical of required) {
				if (outFlags[logical] === undefined) {
					throw new CmdError('E_ARGV_PARSE', 'Invalid arguments', {
						message: `Missing required flag: --${logical}`,
					})
				}
			}

			return {
				flags: outFlags,
				unknownFlags: (parsed.unknownFlags ?? {}) as any,
				_: parsed._ as any,
			}
		}
	}

	return {
		precompile,
		parse(tokens, cfg) {
			return precompile(cfg)(tokens)
		},
	}
}
