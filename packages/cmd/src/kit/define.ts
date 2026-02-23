import { obj } from '../typebox'
import type { ExecCtx, Infer, Interceptor, Schema } from '../core'
import type { McpConfig } from '../mcp'
import type { TextConfig } from '../text'
import type { TextTail } from '../tail'
import type { TProperties } from '../typebox'
import type { TObject } from '@sinclair/typebox'
import type { CmdExt } from '../registry'

import type { BuiltCommandDraft, BuiltOpDraft, CommandDraft, OpDraft } from './draft'
import { cmd as cmdDraft, op as opDraft } from './draft'
import type { KitWithOptions, OpSpec, TextCommandSpec } from './spec'
import { applyPrefix, deriveGroupFromTokens, normalizeRoute } from './route'

import type { CmdDoc } from '../doc'

type Awaitable<T> = T | Promise<T>

type TailMeta = { usage?: string; keys?: readonly string[] }

const readTailMeta = (tail: unknown): TailMeta | null => {
	const m = (tail as any)?.__cmdkitTail as unknown
	if (!m || typeof m !== 'object') return null
	const usage = typeof (m as any).usage === 'string' ? String((m as any).usage).trim() : undefined
	const keysRaw = (m as any).keys as unknown
	const keys =
		Array.isArray(keysRaw) && keysRaw.length
			? keysRaw.map((x: unknown) => String(x ?? '').trim()).filter(Boolean)
			: undefined
	return { ...(usage ? { usage } : {}), ...(keys?.length ? { keys } : {}) }
}

const normalizeDocText = (s: unknown) => String(s ?? '').trim()

const normalizeDoc = (name: string, input?: CmdDoc): Required<Pick<CmdDoc, 'title' | 'description'>> & CmdDoc => {
	const base = normalizeDocText(name) || 'command'
	const rawTitle = normalizeDocText(input?.title) || base
	const rawDescription = normalizeDocText(input?.description)
	const rawUsage = normalizeDocText(input?.usage)

	const internal =
		input === undefined
			? true
			: input.internal !== undefined
				? Boolean(input.internal)
				: !(rawTitle && rawDescription)

	const title = rawTitle
	const description = rawDescription || (internal ? '[internal]' : '')
	const usage = rawUsage || undefined

	if (!internal) {
		if (!title) throw new Error(`[cmdkit] command("${base}"): missing title`)
		if (!description) throw new Error(`[cmdkit] command("${base}"): missing description`)
	}

	return {
		...(input ?? {}),
		title,
		description: description || '[internal]',
		internal,
		...(usage ? { usage } : {}),
	}
}

export type CommandDef<C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt> =
	| {
			kind: 'group'
			with: KitWithOptions
			items: readonly CommandDef<C, Ext>[]
	  }
	| {
			kind: 'command'
			spec: TextCommandSpec<Ext>
			built: BuiltCommandDraft<C, unknown>
	  }
	| {
			kind: 'op'
			spec: OpSpec<Ext>
			built: BuiltOpDraft<C, unknown>
	  }

export type CommandDefInput<C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt> =
	| CommandDef<C, Ext>
	| readonly CommandDefInput<C, Ext>[]
	| null
	| undefined
	| false

export function normalizeDefs<C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt>(
	...inputs: readonly CommandDefInput<C, Ext>[]
): CommandDef<C, Ext>[] {
	const out: CommandDef<C, Ext>[] = []
	const walk = (v: CommandDefInput<C, Ext>) => {
		if (!v) return
		if (Array.isArray(v)) {
			for (const x of v) walk(x)
			return
		}
		out.push(v as CommandDef<C, Ext>)
	}
	for (const input of inputs) walk(input)
	return out
}

export const defs = <C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt>(...items: readonly CommandDefInput<C, Ext>[]) =>
	normalizeDefs<C, Ext>(...items)

export const group = <C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt>(
	withOpts: KitWithOptions | string,
	...items: readonly CommandDefInput<C, Ext>[]
): CommandDef<C, Ext> => {
	const with2: KitWithOptions =
		typeof withOpts === 'string'
			? { prefix: withOpts, group: withOpts }
			: withOpts
	return { kind: 'group', with: with2, items: normalizeDefs<C, Ext>(...items) }
}

export const when = <C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt>(
	condition: unknown,
	...items: readonly CommandDefInput<C, Ext>[]
): CommandDef<C, Ext>[] => (condition ? normalizeDefs<C, Ext>(...items) : [])

type InputObjOptions = Parameters<typeof obj>[1]

type BuilderExtras<T> = Omit<T, keyof CommandBuilder<any, any, any>>

export interface CommandBuilder<C extends ExecCtx, I, Ext extends CmdExt = CmdExt> {
	aliases(...routes: string[]): this
	tags(...tags: string[]): this
	group(group: string): this
	enabled(enabled: boolean): this
	mcp(mcp: McpConfig | false): this
	ext(patch: Partial<Ext>): this

	/** Input is always a strict TypeBox object (`obj({ ... })`). */
	input<P extends TProperties>(
		props: P,
		options?: InputObjOptions,
	): CommandBuilder<C, Infer<TObject<P>>, Ext> & BuilderExtras<this>

	output(schema: Schema): this
	intercept<TState>(itc: Interceptor<TState>): this
	text(cfg: Omit<TextConfig, 'triggers'>): this
	tail(tail: TextTail): this

	/** Finalize this command. */
	handle<R>(fn: (args: { input: I; ctx: C }) => Awaitable<R>): CommandDef<C, Ext>
}

export interface OpBuilder<C extends ExecCtx, I, Ext extends CmdExt = CmdExt> {
	aliases(...routes: string[]): this
	tags(...tags: string[]): this
	group(group: string): this
	enabled(enabled: boolean): this
	mcp(mcp: McpConfig | false): this
	ext(patch: Partial<Ext>): this

	/** Input is always a strict TypeBox object (`obj({ ... })`). */
	input<P extends TProperties>(
		props: P,
		options?: InputObjOptions,
	): OpBuilder<C, Infer<TObject<P>>, Ext> & BuilderExtras<this>

	output(schema: Schema): this
	intercept<TState>(itc: Interceptor<TState>): this

	/** Finalize this op. */
	handle<R>(fn: (args: { input: I; ctx: C }) => Awaitable<R>): CommandDef<C, Ext>
}

const mergeStrings = (base: readonly string[] | undefined, extra: readonly string[]) => {
	const out: string[] = []
	const seen = new Set<string>()
	for (const x of [...(base ?? []), ...extra]) {
		const s = String(x ?? '').trim()
		if (!s || seen.has(s)) continue
		seen.add(s)
		out.push(s)
	}
	return out.length ? out : undefined
}

function createCommandBuilder<C extends ExecCtx, I, Ext extends CmdExt>(state: {
	spec: TextCommandSpec<Ext>
	inputProps?: TProperties
	inputOptions?: InputObjOptions
	output?: Schema
	intercepts: readonly Interceptor<any>[]
	text?: Omit<TextConfig, 'triggers'>
	tail?: TextTail
}): CommandBuilder<C, I, Ext> {
	const withState = <NI,>(next: typeof state & { spec: TextCommandSpec<Ext> }) => createCommandBuilder<C, NI, Ext>(next as any)

	return {
		aliases(...routes) {
			const merged = mergeStrings(state.spec.aliases, routes)
			return withState<I>({ ...state, spec: { ...state.spec, ...(merged ? { aliases: merged } : { aliases: undefined }) } })
		},
		tags(...tags) {
			const merged = mergeStrings(state.spec.tags, tags)
			return withState<I>({ ...state, spec: { ...state.spec, ...(merged ? { tags: merged } : { tags: undefined }) } })
		},
		group(group) {
			return withState<I>({ ...state, spec: { ...state.spec, group: String(group ?? '') } })
		},
		enabled(enabled) {
			return withState<I>({ ...state, spec: { ...state.spec, enabled: Boolean(enabled) } })
		},
		mcp(mcp) {
			return withState<I>({ ...state, spec: { ...state.spec, mcp } })
		},
		ext(patch) {
			const base = (state.spec.ext ?? ({} as any)) as any
			const src = (patch ?? ({} as any)) as any
			const next: any = { ...base }
			for (const [k, v] of Object.entries(src)) {
				if (v === undefined) continue
				const prev = next[k]
				if (prev && typeof prev === 'object' && !Array.isArray(prev) && v && typeof v === 'object' && !Array.isArray(v)) {
					next[k] = { ...prev, ...v }
				} else {
					next[k] = v
				}
			}
			return withState<I>({ ...state, spec: { ...state.spec, ext: next } })
		},
		input(props: any, options?: any) {
			return withState<any>({
				...state,
				inputProps: props,
				inputOptions: options,
			})
		},
		output(schema) {
			return withState<I>({ ...state, output: schema })
		},
		intercept(itc) {
			return withState<I>({ ...state, intercepts: [...state.intercepts, itc] })
		},
		text(cfg) {
			return withState<I>({ ...state, text: cfg })
		},
		tail(t) {
			const meta = readTailMeta(t)
			return withState<I>({
				...state,
				tail: t,
				spec: {
					...state.spec,
					...(meta?.usage ? { tailUsage: meta.usage } : {}),
					...(meta?.keys?.length ? { tailKeys: meta.keys } : {}),
				},
			})
		},
		handle(fn) {
			let d: CommandDraft<C, any> = cmdDraft<C>() as any
			d = d.input(obj((state.inputProps ?? {}) as any, state.inputOptions))
			if (state.output) d = d.output(state.output)
			for (const itc of state.intercepts) d = d.intercept(itc)
			if (state.text) d = d.text(state.text)
			if (state.tail) d = d.text({ ...(state.text ?? {}), tail: state.tail as any })

			const built = d.handleWith(fn as any) as BuiltCommandDraft<C, unknown>
			return { kind: 'command', spec: state.spec, built }
		},
	}
}

function createOpBuilder<C extends ExecCtx, I, Ext extends CmdExt>(state: {
	spec: OpSpec<Ext>
	inputProps?: TProperties
	inputOptions?: InputObjOptions
	output?: Schema
	intercepts: readonly Interceptor<any>[]
}): OpBuilder<C, I, Ext> {
	const withState = <NI,>(next: typeof state & { spec: OpSpec<Ext> }) => createOpBuilder<C, NI, Ext>(next as any)

	return {
		aliases(...routes) {
			const merged = mergeStrings(state.spec.aliases, routes)
			return withState<I>({ ...state, spec: { ...state.spec, ...(merged ? { aliases: merged } : { aliases: undefined }) } })
		},
		tags(...tags) {
			const merged = mergeStrings(state.spec.tags, tags)
			return withState<I>({ ...state, spec: { ...state.spec, ...(merged ? { tags: merged } : { tags: undefined }) } })
		},
		group(group) {
			return withState<I>({ ...state, spec: { ...state.spec, group: String(group ?? '') } })
		},
		enabled(enabled) {
			return withState<I>({ ...state, spec: { ...state.spec, enabled: Boolean(enabled) } })
		},
		mcp(mcp) {
			return withState<I>({ ...state, spec: { ...state.spec, mcp } })
		},
		ext(patch) {
			const base = (state.spec.ext ?? ({} as any)) as any
			const src = (patch ?? ({} as any)) as any
			const next: any = { ...base }
			for (const [k, v] of Object.entries(src)) {
				if (v === undefined) continue
				const prev = next[k]
				if (prev && typeof prev === 'object' && !Array.isArray(prev) && v && typeof v === 'object' && !Array.isArray(v)) {
					next[k] = { ...prev, ...v }
				} else {
					next[k] = v
				}
			}
			return withState<I>({ ...state, spec: { ...state.spec, ext: next } })
		},
		input(props: any, options?: any) {
			return withState<any>({
				...state,
				inputProps: props,
				inputOptions: options,
			})
		},
		output(schema) {
			return withState<I>({ ...state, output: schema })
		},
		intercept(itc) {
			return withState<I>({ ...state, intercepts: [...state.intercepts, itc] })
		},
		handle(fn) {
			let d: OpDraft<C, any> = opDraft<C>() as any
			d = d.input(obj((state.inputProps ?? {}) as any, state.inputOptions))
			if (state.output) d = d.output(state.output)
			for (const itc of state.intercepts) d = d.intercept(itc)
			const built = d.handleWith(fn as any) as BuiltOpDraft<C, unknown>
			return { kind: 'op', spec: state.spec, built }
		},
	}
}

/**
 * Define a text command in a single canonical style:
 *
 * `command('name', { title, description, usage? }).input({ ... }).tail(...).handle(({ input, ctx }) => ...)`
 */
export function command<C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt>(
	name: string,
	doc?: CmdDoc,
): CommandBuilder<C, Infer<TObject<{}>>, Ext> {
	const nm = normalizeDocText(name)
	const d = normalizeDoc(nm, doc)
	const spec: TextCommandSpec<Ext> = {
		name: nm,
		doc: d,
		// MCP-first default for non-internal commands.
		mcp: d.internal ? false : {},
	}
	return createCommandBuilder<C, any, Ext>({
		spec,
		intercepts: [],
	})
}

/**
 * Define a non-text op/tool in a single canonical style:
 *
 * `op('name', { title, description, usage? }).input({ ... }).handle(({ input, ctx }) => ...)`
 */
export function op<C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt>(
	name: string,
	doc?: CmdDoc,
): OpBuilder<C, Infer<TObject<{}>>, Ext> {
	const nm = normalizeDocText(name)
	const d = normalizeDoc(nm, doc)
	const spec: OpSpec<Ext> = {
		name: nm,
		doc: d,
		// MCP-first default for non-internal ops.
		mcp: d.internal ? false : {},
	}
	return createOpBuilder<C, any, Ext>({
		spec,
		intercepts: [],
	})
}

const uniqueStrings = (xs: readonly string[]) => {
	const out: string[] = []
	const seen = new Set<string>()
	for (const x of xs) {
		const s = String(x).trim()
		if (!s) continue
		if (seen.has(s)) continue
		seen.add(s)
		out.push(s)
	}
	return out
}

export type CollectedCommandMeta = {
	kind: 'command' | 'op'
	tokens: string[]
	primary: string
	triggers: string[]
	group?: string
	usage?: string
	description?: string
	internal?: true
}

export function collectCommandMeta<C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt>(
	...inputs: readonly CommandDefInput<C, Ext>[]
): CollectedCommandMeta[] {
	const out: CollectedCommandMeta[] = []

	const walk = (defs: readonly CommandDef<C, Ext>[], state: { prefixTokens: string[]; group?: string }) => {
		for (const def of defs) {
			if (def.kind === 'group') {
				const pfx = String(def.with.prefix ?? '').trim()
				const prefixAppend = pfx ? normalizeRoute(pfx, 'group.with.prefix').tokens : []
				walk(def.items, {
					prefixTokens: [...state.prefixTokens, ...prefixAppend],
					group: def.with.group ?? state.group,
				})
				continue
			}

			if (def.kind === 'op') {
				const spec = def.spec
				if (spec.enabled === false) continue
				const main = normalizeRoute(spec.name, 'op.name')
				const tokens = applyPrefix(state.prefixTokens, main.tokens)
				const primary = tokens.join(' ')
				out.push({
					kind: 'op',
					tokens: [...tokens],
					primary,
					triggers: [primary],
					group: spec.group ?? state.group ?? deriveGroupFromTokens(tokens),
					usage: spec.doc.usage,
					description: spec.doc.description,
					...(spec.doc.internal ? { internal: true } : {}),
				})
				continue
			}

			const spec = def.spec
			if (spec.enabled === false) continue
			const main = normalizeRoute(spec.name, 'command.name')
			const tokens = applyPrefix(state.prefixTokens, main.tokens)
			const aliasRoutes = (spec.aliases ?? []).map((a, i) => normalizeRoute(a, `command.aliases[${i}]`))
			const triggers = uniqueStrings([
				tokens.join(' '),
				...aliasRoutes.map((a) => applyPrefix(state.prefixTokens, a.tokens).join(' ')),
			])
			const primary = triggers[0] ?? tokens.join(' ')
			out.push({
				kind: 'command',
				tokens: [...tokens],
				primary,
				triggers: [...triggers],
				group: spec.group ?? state.group ?? deriveGroupFromTokens(tokens),
				usage: spec.doc.usage,
				description: spec.doc.description,
				...(spec.doc.internal ? { internal: true } : {}),
			})
		}
	}

	walk(normalizeDefs<C, Ext>(...inputs), { prefixTokens: [], group: undefined })
	return out
}
