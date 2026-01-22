import type { AxAI, AxFunction } from '@ax-llm/ax'
import { pluginMethodDecorator } from '@pluxel/hmr'

import type { ExecCtx } from '@pluxel/cmd'

import { Ax } from './core'

export type AxTooling = { ai: AxAI; functions: AxFunction[] }

type CtxBuilder<Args extends any[]> = (args: Args, method: string) => ExecCtx | undefined

/**
 * Method decorator: inject `AxAI` as the **first arg**.
 *
 * Usage:
 * ```ts
 * class Foo extends BasePlugin {
 *   constructor(private axSvc: Ax) { super() }
 *
 *   @WithAxAI()
 *   async summarize(ai: AxAI, text: string) {
 *     return await ax('msg:string -> out:string').forward(ai, { msg: text })
 *   }
 * }
 * ```
 */
export function WithAxAI<Args extends any[] = any[]>(opts?: { profileId?: string; ctx?: ExecCtx | CtxBuilder<Args> }): MethodDecorator {
	return pluginMethodDecorator(Ax, async function (original: (...args: any[]) => any, axSvc: Ax, key, ...args: any[]) {
		const method = String(key)
		const ctx = typeof opts?.ctx === 'function' ? (opts.ctx as any)(args, method) : opts?.ctx
		const ai = await axSvc.ai({ profileId: opts?.profileId, ctx })
		return await original.call(this, ai, ...args)
	})
}

/**
 * Method decorator: inject `{ ai, functions }` as the **first arg**.
 *
 * Best for agents / function-calling flows.
 */
export function WithAxTooling<Args extends any[] = any[]>(opts?: {
	profileId?: string
	ctx?: ExecCtx | CtxBuilder<Args>
	functions?: AxFunction[]
}): MethodDecorator {
	return pluginMethodDecorator(Ax, async function (original: (...args: any[]) => any, axSvc: Ax, key, ...args: any[]) {
		const method = String(key)
		const ctx = typeof opts?.ctx === 'function' ? (opts.ctx as any)(args, method) : opts?.ctx
		const tooling = await axSvc.tooling({ profileId: opts?.profileId, ctx, functions: opts?.functions })
		return await original.call(this, tooling, ...args)
	})
}
