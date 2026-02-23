import type { ExecCtx } from './core'
import type { Result } from './result'
import type { CmdError } from './core'

import { CommandRegistry } from './registry'
import type { CmdExt, RegisteredCommandInfo } from './registry'

import { createCommandKit } from './kit/kit'
import type { CommandKit } from './kit/kit'
import { command, defs, group, op, when } from './kit/define'
import type { CommandDefInput } from './kit/define'
import type { KitWithOptions } from './kit/spec'

import { tail } from './tail'
import { Type, obj, openObj, TypeBox } from './typebox'
import type { Static, TSchema, TAnySchema, TProperties } from './typebox'
import type { CmdDoc } from './doc'

export type CommandScope<C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt> = {
	readonly scopeKey: string

	with(opts: KitWithOptions): CommandScope<C, Ext>
	with(opts: KitWithOptions, fn: (kit: CommandScope<C, Ext>) => void): void

	install(...defs: readonly CommandDefInput<C, Ext>[]): void

	// Definition helpers (typed to this scope's ctx).
	command(name: string, doc?: CmdDoc): ReturnType<typeof command<C, Ext>>
	op(name: string, doc?: CmdDoc): ReturnType<typeof op<C, Ext>>
	defs(...items: readonly CommandDefInput<C, Ext>[]): ReturnType<typeof defs<C, Ext>>
	group(withOpts: KitWithOptions | string, ...items: readonly CommandDefInput<C, Ext>[]): ReturnType<typeof group<C, Ext>>
	when(condition: unknown, ...items: readonly CommandDefInput<C, Ext>[]): ReturnType<typeof when<C, Ext>>

	// Re-exported building blocks for convenience (single mental model).
	readonly Type: typeof Type
	readonly TypeBox: typeof TypeBox
	readonly obj: typeof obj
	readonly openObj: typeof openObj
	readonly tail: typeof tail
}

export type CommandSpace<C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt> = {
	readonly registry: CommandRegistry<C, Ext>

	scope(
		scopeKey: string,
		opts?: {
			idOf?: Parameters<typeof createCommandKit<C, Ext>>[1]['idOf']
			mcpNameOf?: Parameters<typeof createCommandKit<C, Ext>>[1]['mcpNameOf']
			decorate?: Parameters<typeof createCommandKit<C, Ext>>[1]['decorate']
		},
	): CommandScope<C, Ext>

	dispatch(text: string, ctx?: C): Promise<Result<unknown, CmdError>>

	list(): Array<
		{
			id: string
			scopeKey: string | null
			mcpName: string | null
		} & RegisteredCommandInfo<Ext>
	>

	help(group?: string): string

	listMcpTools(): ReturnType<CommandRegistry<C, Ext>['listMcpTools']>

	cleanup(scopeKey: string): void
}

export function createCommandSpace<C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt>(opts?: {
	caseInsensitive?: boolean
	warn?: (msg: string, meta?: unknown) => void
}): CommandSpace<C, Ext> {
	const registry = new CommandRegistry<C, Ext>({
		caseInsensitive: opts?.caseInsensitive ?? true,
		warn: opts?.warn,
	})

	const scope = (scopeKey: string, scopeOpts?: Parameters<CommandSpace<C, Ext>['scope']>[1]): CommandScope<C, Ext> => {
		const kit: CommandKit<C, Ext> = createCommandKit<C, Ext>(registry, {
			scopeKey,
			...(scopeOpts?.idOf ? { idOf: scopeOpts.idOf } : {}),
			...(scopeOpts?.mcpNameOf ? { mcpNameOf: scopeOpts.mcpNameOf } : {}),
			...(scopeOpts?.decorate ? { decorate: scopeOpts.decorate } : {}),
		})

		const wrap = (inner: CommandKit<C, Ext>): CommandScope<C, Ext> => {
			const withFn = ((withOpts: KitWithOptions, fn?: (kit: CommandScope<C, Ext>) => void) => {
				const derived = inner.with(withOpts) as any
				const wrapped = wrap(derived)
				if (typeof fn === 'function') {
					fn(wrapped)
					return
				}
				return wrapped
			}) as CommandScope<C, Ext>['with']

			return {
				scopeKey,
				with: withFn,
				install: (...items) => inner.install(...items),

				command: (name, doc) => command<C, Ext>(name, doc) as any,
				op: (name, doc) => op<C, Ext>(name, doc) as any,
				defs: (...items) => defs<C, Ext>(...items) as any,
				group: (withOpts, ...items) => group<C, Ext>(withOpts as any, ...(items as any)) as any,
				when: (cond, ...items) => when<C, Ext>(cond, ...(items as any)) as any,

				Type,
				TypeBox,
				obj,
				openObj,
				tail,
			}
		}

		return wrap(kit)
	}

	const space: CommandSpace<C, Ext> = {
		registry,

		scope,

		dispatch: (text, ctx) => registry.dispatch(text, ctx),

		list() {
			const out: Array<
				{
					id: string
					scopeKey: string | null
					mcpName: string | null
				} & RegisteredCommandInfo<Ext>
			> = []
			for (const { id, scopeKey, info } of registry.list()) {
				out.push({
					id,
					scopeKey,
					mcpName: registry.getMcpName(id),
					...info,
					tokens: info.tokens.slice(),
					triggers: info.triggers.slice(),
					...(info.tags ? { tags: info.tags.slice() } : {}),
					...(info.ext ? { ext: { ...(info.ext as any) } } : {}),
					...(info.tailKeys ? { tailKeys: info.tailKeys.slice() } : {}),
				})
			}
			out.sort((a, b) => a.primary.localeCompare(b.primary))
			return out
		},

		help(arg?: string) {
			const groupArg = String(arg ?? '').trim()
			const list = this.list().filter((c) => !groupArg || (c.group ?? '').toLowerCase() === groupArg.toLowerCase())
			if (list.length === 0) return ''
			const lines: string[] = []
			for (const c of list) {
				const head = c.usage ?? c.primary
				const desc = c.description ? ` — ${c.description}` : ''
				lines.push(`- ${head}${desc}`)
			}
			return lines.join('\n')
		},

		listMcpTools: () => registry.listMcpTools(),

		cleanup: (scopeKey) => registry.cleanupCommandsForScope(scopeKey),
	}

	return space
}

// Re-exported types for downstream convenience (keeps consumers on one import path).
export type { Static, TSchema, TAnySchema, TProperties }
