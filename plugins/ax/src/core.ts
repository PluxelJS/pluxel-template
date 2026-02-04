import type { AxAI, AxFunction } from '@ax-llm/ax'
import type { Context } from '@pluxel/hmr'
import { BasePlugin } from '@pluxel/hmr'

import type { DocContext, ExecCtx, Executable, McpExecutable } from '@pluxel/cmd'

import { cmdExecutableToAxFunction } from './cmdkit'

type ToolRecord = {
	ownerKey: string
	fn: AxFunction
}

function isExecutableLike(v: unknown): v is Executable<any, any> {
	return !!v && typeof v === 'object' && typeof (v as any).exec === 'function'
}

function isMcpExecutableLike(v: unknown): v is McpExecutable<any, any> {
	return isExecutableLike(v) && !!(v as any).mcp && typeof (v as any).mcp === 'object'
}

class AxToolRegistry {
	private readonly byName = new Map<string, ToolRecord>()
	private readonly namesByOwner = new Map<string, Set<string>>()

	register(ownerKey: string, fn: AxFunction): void {
		if (typeof (fn as any)?.func !== 'function') throw new Error('[ax] tool(): tool.func must be a function')
		const nameRaw = String((fn as any)?.name ?? '')
		const name = nameRaw.trim()
		if (!name) throw new Error('[ax] tool(): tool.name must be non-empty')
		if (name !== nameRaw) throw new Error(`[ax] tool(): tool.name must be trimmed ("${name}")`)

		const existing = this.byName.get(name)
		if (existing && existing.ownerKey !== ownerKey) {
			throw new Error(`[ax] tool(): tool name conflict "${name}" already registered by "${existing.ownerKey}"`)
		}

		this.byName.set(name, { ownerKey, fn })
		let bucket = this.namesByOwner.get(ownerKey)
		if (!bucket) {
			bucket = new Set()
			this.namesByOwner.set(ownerKey, bucket)
		}
		bucket.add(name)
	}

	unregisterOwner(ownerKey: string): void {
		const bucket = this.namesByOwner.get(ownerKey)
		if (!bucket || bucket.size === 0) return
		for (const name of Array.from(bucket)) {
			const cur = this.byName.get(name)
			if (cur?.ownerKey === ownerKey) this.byName.delete(name)
			bucket.delete(name)
		}
		this.namesByOwner.delete(ownerKey)
	}

	list(): AxFunction[] {
		return Array.from(this.byName.values())
			.map((r) => r.fn)
			.sort((a: any, b: any) => String(a?.name ?? '').localeCompare(String(b?.name ?? '')))
	}
}

/**
 * Minimal Ax service surface for other plugins.
 *
 * Design goals:
 * - Stable DI token: other plugins depend on `Ax` (this class) and do not care about the provider.
 * - Small API: build on top of `ai()` + tool registry + cmdkit bridge.
 * - Explicit behavior: this plugin never "silently" converts your payload formats; helpers live in `pluxel-plugin-ax/toon`.
 */
export abstract class Ax extends BasePlugin {
	private readonly tools = new AxToolRegistry()
	private readonly ownerCtxById = new Map<string, Context>()
	private readonly cleanupAttached = new WeakMap<Context, true>()

	protected requireCaller(method: string): Context {
		const caller = this.ctx.caller
		if (!caller?.pluginInfo?.id) throw new Error(`[ax] ${method}() requires caller context (call it inside a plugin)`)
		return caller as any
	}

	protected ownerKeyForCaller(caller: Context): string {
		const id = String((caller as any)?.pluginInfo?.id ?? '').trim()
		if (!id) throw new Error('[ax] invalid caller plugin id')
		return id
	}

	/**
	 * Resolve (or create) an Ax AI instance.
	 *
	 * Provider selection is data-driven by the provider plugin (e.g. `AxHub` profiles).
	 */
	abstract ai(opts?: { profileId?: string; ctx?: ExecCtx }): Promise<AxAI>

	/**
	 * Register a raw Ax function tool (owned by the caller plugin).
	 *
	 * Notes:
	 * - Tool names must be globally unique across plugins.
	 * - Ownership is bound to the caller plugin context; tools are auto-unregistered on plugin dispose/restart.
	 */
	tool(fn: AxFunction): void {
		const caller = this.requireCaller('tool')
		const ownerKey = this.ownerKeyForCaller(caller)

		const prev = this.ownerCtxById.get(ownerKey)
		if (prev && prev !== caller) {
			// Hot-reload safety: if owner context changed, drop old registrations.
			this.tools.unregisterOwner(ownerKey)
		}
		this.ownerCtxById.set(ownerKey, caller)

		if (!this.cleanupAttached.has(caller)) {
			this.cleanupAttached.set(caller, true)
			const guard = caller.effects.defer(() => {
				try {
					this.tools.unregisterOwner(ownerKey)
				} catch {
					// ignore
				} finally {
					if (this.ownerCtxById.get(ownerKey) === caller) this.ownerCtxById.delete(ownerKey)
				}
			}, { tag: `ax:tools:owner:${ownerKey}` })
			// If the provider unloads first, detach from caller effects to avoid cross-plugin retention.
			this.ctx.effects.defer(() => guard.cancel(), { tag: `ax:tools:provider-detach:${ownerKey}` })
		}

		this.tools.register(ownerKey, fn)
	}

	/** Register all MCP-enabled cmdkit executables found in a module exports object. */
	cmdExports(
		exportsObj: Record<string, unknown>,
		opts?: { docCtx?: DocContext; execCtx?: ExecCtx | ((args: unknown, extra: unknown) => ExecCtx | undefined) },
	): void {
		for (const v of Object.values(exportsObj ?? {})) {
			if (!isMcpExecutableLike(v)) continue
			this.cmd(v, opts)
		}
	}

	/** Register all MCP-enabled cmdkit executables from a cmd-catalog-like object. */
	cmdCatalog(
		catalog: { mcpTools: (ctx?: DocContext) => Array<{ exec: McpExecutable<any, any> }> },
		opts?: { docCtx?: DocContext; execCtx?: ExecCtx | ((args: unknown, extra: unknown) => ExecCtx | undefined) },
	): void {
		for (const t of catalog.mcpTools(opts?.docCtx)) {
			this.cmd(t.exec, opts)
		}
	}

	/**
	 * Register a cmdkit executable as an Ax tool, using its `.mcp` metadata (owned by the caller plugin).
	 *
	 * This is the recommended integration path: cmdkit remains the "single source of truth" for tool schemas.
	 */
	cmd(
		exec: McpExecutable<any, any> | Executable<any, any>,
		opts?: { docCtx?: DocContext; execCtx?: ExecCtx | ((args: unknown, extra: unknown) => ExecCtx | undefined) },
	): void {
		if (!isMcpExecutableLike(exec)) {
			throw new Error('[ax] cmd(): executable is missing .mcp (opt-in required)')
		}
		this.tool(cmdExecutableToAxFunction(exec as any, opts))
	}

	/** Current tool list (sorted by name). */
	functions(): AxFunction[] {
		return this.tools.list()
	}

	/**
	 * Convenience for Ax consumers: get `{ ai, functions }` ready to pass into `ax(...)/agent(...)`.
	 *
	 * `functions` is the current registry snapshot; callers may add extra functions explicitly.
	 */
	async tooling(opts?: { profileId?: string; ctx?: ExecCtx; functions?: AxFunction[] }): Promise<{ ai: AxAI; functions: AxFunction[] }> {
		const ai = await this.ai({ profileId: opts?.profileId, ctx: opts?.ctx })
		const base = this.functions()
		const extra = opts?.functions?.length ? opts.functions : []
		if (extra.length === 0) return { ai, functions: base }

		const seen = new Set(base.map((f: any) => String(f?.name ?? '').trim()).filter(Boolean))
		for (const fn of extra) {
			const name = String((fn as any)?.name ?? '').trim()
			if (!name) throw new Error('[ax] tooling(): extra function name must be non-empty')
			if (seen.has(name)) throw new Error(`[ax] tooling(): function name conflict "${name}"`)
			seen.add(name)
		}

		return { ai, functions: [...base, ...extra] }
	}
}
