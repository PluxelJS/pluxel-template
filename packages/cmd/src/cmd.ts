import type { AnyStdSchema, ExecCtx, InferOut, Interceptor, StrictEmptyObject } from './core'
import { CmdError, STRICT_EMPTY_OBJECT_SCHEMA, normalizeError } from './core'
import { CMDKIT_TEXT_RUNNER, type TextInvocation } from './text-runner'

import type { CmdDocSource } from './doc'
import { mergeDocSources } from './doc'
import type { McpConfig, McpMeta } from './mcp'
import { compileMcpMeta } from './mcp'
import type { ExecutableMeta, TextConfig } from './text'
import { compileTextPlan } from './text'
import { compileInterceptors, execPlanResult, type ExecSpec } from './exec'
import type { Result } from './result'
import { createErr } from './result'

export { CmdError } from './core'
export type { CmdErrorCode } from './core'

export type { CmdDoc, CmdDocSource, DocContext, DocProvider, DocTextProvider, DocTextSource } from './doc'
export { resolveDoc, resolveText } from './doc'

export type { McpConfig, McpMeta } from './mcp'

export type { ExecutableMeta, ParamSpec, TextConfig } from './text'
export type { Err, Ok, Result } from './result'
export { ResultOperator, createErr, createOk, expectErr, expectOk, isErr, isOk, unwrapErr, unwrapOk } from './result'

export interface Executable<I, O> {
	readonly id: string
	/** Optional human doc (shared by text + MCP/tool). */
	readonly doc?: CmdDocSource
	/**
	 * Optional MCP opt-in metadata.
	 *
	 * When present, upstream can register this executable as an MCP tool.
	 */
	readonly mcp?: McpMeta
	/** Raw input schema (Standard Schema). */
	readonly inputSchema: AnyStdSchema
	/** Raw output schema (Standard Schema), if any. */
	readonly outputSchema?: AnyStdSchema
	readonly meta?: ExecutableMeta
	exec(value: unknown, ctx?: ExecCtx): Promise<Result<O, CmdError>>
	execText?: (text: string, ctx?: ExecCtx) => Promise<Result<O, CmdError>>
}

export type TextExecutable<I, O> = Executable<I, O> & {
	execText: (text: string, ctx?: ExecCtx) => Promise<Result<O, CmdError>>
	meta: ExecutableMeta
}

export type McpExecutable<I, O> = Executable<I, O> & {
	mcp: McpMeta
}

export function isTextExecutable<I, O>(exec: Executable<I, O>): exec is TextExecutable<I, O> {
	return typeof exec.execText === 'function'
}

export function isMcpExecutable<I, O>(exec: Executable<I, O>): exec is McpExecutable<I, O> {
	return !!exec.mcp
}

export type AnyExecutable = Executable<any, any>

/**
 * Runtime guard for filtering unknown module exports.
 *
 * This intentionally checks only the stable public surface:
 * - `id: string`
 * - `exec(value, ctx?): Promise<Result<...>>`
 */
export function isExecutable(x: unknown): x is AnyExecutable {
	if (!x || typeof x !== 'object') return false
	return typeof (x as any).id === 'string' && typeof (x as any).exec === 'function'
}

type State = { hasHandle: boolean; hasText: boolean; hasMcp: boolean }

type BuilderSpec = ExecSpec & {
	doc?: CmdDocSource
	mcp?: McpConfig
	text?: TextConfig
}

function makeExecutable<I, O>(spec: BuilderSpec): Executable<I, O> {
	const compiled = compileInterceptors(spec.interceptors)

	const execFn = async (value: unknown, ctx?: ExecCtx) =>
		await execPlanResult<I, O>(spec, compiled, value, ctx)

	const executable: Executable<I, O> = {
		id: spec.id,
		...(spec.doc ? { doc: spec.doc } : {}),
		...(spec.mcp ? { mcp: compileMcpMeta(spec.id, spec.input, spec.output, spec.mcp) } : {}),
		inputSchema: spec.input,
		...(spec.output ? { outputSchema: spec.output } : {}),
		exec: execFn,
	}

	if (spec.text) {
		// Compile text plan at build time from the final input schema.
		const compiledText = compileTextPlan(spec.id, spec.input, spec.text)
		;(executable as any).meta = compiledText.meta

		const runner = async (inv: TextInvocation, ctx?: ExecCtx): Promise<Result<O, CmdError>> => {
			try {
				const candidate = compiledText.parseCandidate(inv)

				return await execPlanResult<I, O>(spec, compiled, candidate, ctx)
			} catch (e) {
				return createErr(normalizeError(ctx, e, 'E_INTERNAL', 'Command failed'))
			}
		}

		;(executable as any)[CMDKIT_TEXT_RUNNER] = runner

		executable.execText = async (text: string, ctx?: ExecCtx) => {
			try {
				const tokens = compiledText.tokenize(text)
				const m = compiledText.match(tokens)
				if (!m) {
					return createErr(
						new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Text does not match any trigger for "${spec.id}"` }),
					)
				}
				return await runner({ text, tokens, consumed: m.consumed }, ctx)
			} catch (e) {
				return createErr(normalizeError(ctx, e, 'E_INTERNAL', 'Command failed'))
			}
		}
	}

	return executable
}

export interface CmdBuilder<I, O, S extends State> {
	input<T extends AnyStdSchema>(schema: T): CmdBuilder<InferOut<T>, O, S>
	output<T extends AnyStdSchema>(schema: T): CmdBuilder<I, InferOut<T>, S>

	doc(doc: CmdDocSource): CmdBuilder<I, O, S>
	/** Explicitly opt-in to exposing this executable as an MCP tool. */
	mcp(cfg: McpConfig): CmdBuilder<I, O, { hasHandle: S['hasHandle']; hasText: S['hasText']; hasMcp: true }>
	intercept<TState>(itc: Interceptor<TState>): CmdBuilder<I, O, S>

	handle(
		fn: (input: I, ctx: ExecCtx) => O | Promise<O>,
	): CmdBuilder<I, O, { hasHandle: true; hasText: S['hasText']; hasMcp: S['hasMcp'] }>
	/**
	 * Enable text execution for this command.
	 *
	 * If `cfg.triggers` is omitted, defaults to `[id]`.
	 */
	text(cfg?: TextConfig): CmdBuilder<I, O, { hasHandle: S['hasHandle']; hasText: true; hasMcp: S['hasMcp'] }>

	build(this: CmdBuilder<I, O, { hasHandle: true; hasText: S['hasText']; hasMcp: S['hasMcp'] }>): Executable<I, O> &
		(S['hasText'] extends true ? { execText: (text: string, ctx?: ExecCtx) => Promise<Result<O, CmdError>>; meta: ExecutableMeta } : {}) &
		(S['hasMcp'] extends true ? { mcp: McpMeta } : {})
}

function builder<I, O, S extends State>(spec: BuilderSpec): CmdBuilder<I, O, S> {
	const api: CmdBuilder<I, O, S> = {
		input(schema: any) {
			return builder<any, O, S>({ ...spec, input: schema })
		},
		output(schema: any) {
			return builder<I, any, S>({ ...spec, output: schema })
		},
		doc(doc: CmdDocSource) {
			return builder<I, O, S>({ ...spec, doc: mergeDocSources(spec.doc, doc) })
		},
		mcp(cfg: McpConfig) {
			return builder<I, O, any>({ ...spec, mcp: cfg })
		},
		intercept(itc: any) {
			return builder<I, O, S>({ ...spec, interceptors: [...spec.interceptors, itc] })
		},
		handle(fn: any) {
			return builder<I, O, any>({ ...spec, handle: fn })
		},
		text(cfg?: TextConfig) {
			const triggers = Array.isArray(cfg?.triggers) ? cfg!.triggers.slice() : undefined
			const tail = cfg?.tail
			return builder<I, O, any>({ ...spec, text: { ...(triggers ? { triggers } : {}), ...(tail ? { tail } : {}) } })
		},
		build() {
			return makeExecutable<I, O>(spec) as any
		},
	}
	return api
}

export function cmd(id: string): CmdBuilder<StrictEmptyObject, unknown, { hasHandle: false; hasText: false; hasMcp: false }> {
	const trimmed = String(id).trim()
	if (!trimmed) {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'cmd(id): id must be non-empty' })
	}
	const spec: BuilderSpec = {
		id: trimmed,
		input: STRICT_EMPTY_OBJECT_SCHEMA as AnyStdSchema,
		interceptors: [],
	}
	return builder<any, any, any>(spec) as any
}
