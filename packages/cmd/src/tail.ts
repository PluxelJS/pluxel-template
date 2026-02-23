import { Runtime } from '@sinclair/parsebox'

import { defaultTokenizer } from './tokenize'

export type TailPatch = Record<string, unknown>

type OutputOfParser<P> = P extends Runtime.IParser<infer Output> ? Output : unknown

export type TextTail<
	Properties extends Runtime.IProperties = Runtime.IProperties,
	Entry extends keyof Properties = keyof Properties,
	Output = OutputOfParser<Properties[Entry]>,
> = {
	module: Runtime.Module<Properties>
	entry: Entry
	_output?: Output
}

export type InferTextTail<T extends TextTail> = T extends TextTail<any, any, infer Output> ? Output : unknown

export const textTail = <Properties extends Runtime.IProperties, Entry extends keyof Properties>(
	module: Runtime.Module<Properties>,
	entry: Entry,
): TextTail<Properties, Entry> => {
	return { module, entry } as any
}

type CmdkitTailMeta = {
	/** Usage placeholder for help/UI derivation. Example: `<expr>` */
	usage?: string
	/** Input keys that this tail writes into (used to hide redundant `--<key>` flags). */
	keys?: readonly string[]
}

const withMeta = <T extends object>(tail: T, meta: CmdkitTailMeta): T => Object.assign(tail as any, { __cmdkitTail: meta })

const normalizePatch = (patch: unknown): TailPatch => {
	if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {}
	const out: TailPatch = {}
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue
		out[k] = v
	}
	return out
}

const raw = (map: (raw: string) => TailPatch, meta?: CmdkitTailMeta) => {
	const t = textTail(
		new Runtime.Module({
			Main: Runtime.Until(['\n'], (s) => normalizePatch(map(String(s ?? '').trim()))),
		}),
		'Main',
	)
	return meta ? withMeta(t, meta) : t
}

const args = (map: (args: string[]) => Record<string, unknown>, meta?: CmdkitTailMeta) => {
	const t = textTail(
		new Runtime.Module({
			Main: Runtime.Until(['\n'], (s) => {
				const raw = String(s ?? '').trim()
				const tokens = raw ? defaultTokenizer(raw) : []
				const args = tokens.map((t) => t.value)
				return normalizePatch(map(args))
			}),
		}),
		'Main',
	)
	return meta ? withMeta(t, meta) : t
}

const line = (key: string, opts?: { defaultValue?: string; empty?: 'omit' | 'keep'; trim?: boolean }) =>
	raw(
		(s) => {
			const shouldTrim = opts?.trim ?? true
			const value = shouldTrim ? s.trim() : s
			if (!value) {
				if (opts?.defaultValue !== undefined) return { [key]: opts.defaultValue }
				if (opts?.empty === 'keep') return { [key]: '' }
				return {}
			}
			return { [key]: value }
		},
		{ usage: `<${key}>`, keys: [key] },
	)

const join = (key: string, opts?: { sep?: string }) =>
	args(
		(args) => (args.length ? ({ [key]: args.join(opts?.sep ?? ' ') } satisfies TailPatch) : {}),
		{ usage: `<${key}>`, keys: [key] },
	)

const first = (key: string) =>
	args(
		(args) => (args[0] ? ({ [key]: args[0] } satisfies TailPatch) : {}),
		{ usage: `<${key}>`, keys: [key] },
	)

const array = (key = 'args') =>
	args((args) => ({ [key]: args } satisfies TailPatch), { usage: `<${key}...>`, keys: [key] })

const custom = <Properties extends Runtime.IProperties, Entry extends keyof Properties>(
	module: Runtime.Module<Properties>,
	entry: Entry,
	meta?: CmdkitTailMeta,
) => {
	const t = textTail(module, entry)
	return meta ? withMeta(t, meta) : t
}

export const tail = {
	raw,
	args,
	line,
	join,
	first,
	array,
	custom,
} as const
