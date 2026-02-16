import { Type, type TSchema } from '@sinclair/typebox'
import type { Static } from '@sinclair/typebox'
import type { TypeCheck } from '@sinclair/typebox/compiler'
import { TypeCompiler } from '@sinclair/typebox/compiler'
import type { ValueError } from '@sinclair/typebox/errors'
import { Value } from '@sinclair/typebox/value'

export type CmdErrorCode =
	| 'E_CMD_NOT_FOUND'
	| 'E_TEXT_PARSE'
	| 'E_INPUT_VALIDATION'
	| 'E_OUTPUT_VALIDATION'
	| 'E_FORBIDDEN'
	| 'E_RATE_LIMITED'
	| 'E_ABORTED'
	| 'E_TIMEOUT'
	| 'E_DEPENDENCY'
	| 'E_INTERNAL'

export type CmdErrorKind = 'expected' | 'fault'

export type ValidationIssue = {
	path?: Array<string | number>
	message: string
	code?: string
	meta?: Record<string, unknown>
}

export const issue = (
	message: string,
	opts?: { path?: Array<string | number>; code?: string; meta?: Record<string, unknown> },
): ValidationIssue => ({
	message,
	...(opts?.path ? { path: opts.path } : {}),
	...(opts?.code ? { code: opts.code } : {}),
	...(opts?.meta ? { meta: opts.meta } : {}),
})

export type CmdErrorDetailsByCode = {
	E_CMD_NOT_FOUND?: { text?: string; tokens?: string[] }
	E_TEXT_PARSE?: { reason?: string }
	E_INPUT_VALIDATION?: { issues: ValidationIssue[] }
	E_OUTPUT_VALIDATION?: { issues: ValidationIssue[] }
	E_FORBIDDEN?: { node?: string; reason?: string }
	E_RATE_LIMITED?: { decision?: unknown }
	E_ABORTED?: { reason?: unknown }
	E_TIMEOUT?: { now?: number; deadlineMs?: number }
	E_DEPENDENCY?: { service?: string; operation?: string; retryable?: boolean; causeCode?: string }
	/** Internal errors may carry implementation-defined diagnostics. */
	E_INTERNAL?: Record<string, unknown>
}

export type CmdErrorDetails<C extends CmdErrorCode = CmdErrorCode> = C extends keyof CmdErrorDetailsByCode
	? NonNullable<CmdErrorDetailsByCode[C]> | undefined
	: Record<string, unknown> | undefined

export class CmdError<C extends CmdErrorCode = CmdErrorCode> extends Error {
	public readonly code: C
	public readonly kind: CmdErrorKind
	public readonly publicMessage: string
	public readonly details?: CmdErrorDetails<C>

	constructor(
		code: C,
		publicMessage: string,
		opts?: { message?: string; details?: CmdErrorDetails<C>; cause?: unknown; kind?: CmdErrorKind },
	) {
		super(opts?.message ?? publicMessage, opts?.cause !== undefined ? { cause: opts.cause } : undefined)
		this.name = 'CmdError'
		this.code = code
		this.kind = opts?.kind ?? kindOfCmdErrorCode(code)
		this.publicMessage = publicMessage
		this.details = opts?.details
	}

	toJSON() {
		const cause = (this as any).cause
		return {
			name: this.name,
			code: this.code,
			kind: this.kind,
			publicMessage: this.publicMessage,
			message: this.message,
			...(this.details !== undefined ? { details: this.details } : {}),
			...(cause ? { cause: { name: cause?.name, message: cause?.message, code: (cause as any)?.code } } : {}),
		}
	}
}

export const kindOfCmdErrorCode = (code: CmdErrorCode): CmdErrorKind => {
	// Keep this "small and hard": anything not explicitly a business branch is a fault.
	if (code === 'E_INTERNAL' || code === 'E_DEPENDENCY') return 'fault'
	return 'expected'
}

export const toCmdError = (e: unknown, fallbackCode: CmdErrorCode, fallbackPublic: string): CmdError => {
	if (e instanceof CmdError) return e

	if (e && typeof e === 'object' && typeof (e as any).code === 'string' && typeof (e as any).publicMessage === 'string') {
		const code = (e as any).code as CmdErrorCode
		const publicMessage = String((e as any).publicMessage)
		const kind = (e as any).kind as CmdErrorKind | undefined
		if (kind === 'expected' || kind === 'fault') return e as any
		return new CmdError(code, publicMessage, {
			message: typeof (e as any).message === 'string' ? (e as any).message : publicMessage,
			details: (e as any).details,
			cause: (e as any).cause ?? e,
		})
	}

	const message = (e as any)?.message ?? fallbackPublic
	return new CmdError(fallbackCode, fallbackPublic, { message, cause: e })
}

export const normalizeError = (ctx: ExecCtx | undefined, e: unknown, fallbackCode: CmdErrorCode, fallbackPublic: string): CmdError => {
	if (e instanceof CmdError) return e
	const classified = ctx?.classifyError?.(e)
	if (classified) return classified
	return toCmdError(e, fallbackCode, fallbackPublic)
}

export interface ExecCtx {
	signal?: AbortSignal
	deadlineMs?: number
	now?: number
	emit?: (type: string, payload: Record<string, unknown>) => void
	span?: <T>(name: string, attrs: Record<string, unknown>, fn: () => T | Promise<T>) => Promise<T>
		/**
		 * Optional error classifier hook.
		 *
		 * Use this to map infrastructure errors into structured CmdError codes
		 * (e.g. wrap a DB/network error into `E_DEPENDENCY`), before @pluxel/cmd falls
		 * back to `E_INTERNAL`.
		 */
		classifyError?: (e: unknown) => CmdError | undefined
	/**
	 * Optional fault hook (for stack-level reporting/alerting).
	 *
	 * Called only when `err.kind === "fault"`. Implementations MUST NOT throw.
	 */
	onFault?: (payload: { id: string; err: CmdError; durationMs: number; recovered: boolean }) => void | Promise<void>
	/** Optional extra info for upstream usage. */
	meta?: Record<string, unknown>
}

const isPromiseLike = (v: unknown): v is PromiseLike<unknown> =>
	!!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as any).then === 'function'

export const nowMs = (ctx?: ExecCtx) => (typeof ctx?.now === 'number' ? ctx.now : Date.now())

export function throwIfStopped(ctx?: ExecCtx): void {
	if (!ctx) return
	const now = nowMs(ctx)
	if (ctx.signal?.aborted) {
		throw new CmdError('E_ABORTED', 'Cancelled', {
			details: { reason: (ctx.signal as any).reason },
			cause: (ctx.signal as any).reason,
		})
	}
	if (ctx.deadlineMs !== undefined && now > ctx.deadlineMs) {
		throw new CmdError('E_TIMEOUT', 'Timeout', { details: { now, deadlineMs: ctx.deadlineMs } })
	}
}

export type JsonSchema = Record<string, unknown>

export type StrictEmptyObject = Record<string, never>

export type Schema = TSchema
export type Infer<S extends Schema> = Static<S>

export const STRICT_EMPTY_OBJECT_SCHEMA = Type.Object({}, { additionalProperties: false })

export type JsonValidationOk<T> = { ok: true; value: T }
export type JsonValidationErr = { ok: false; issues: ValidationIssue[] }
export type JsonValidationResult<T> = JsonValidationOk<T> | JsonValidationErr
export type JsonValidator<T> = (value: unknown) => JsonValidationResult<T>

export type CustomValidator<T, Ctx extends ExecCtx = ExecCtx> = (
	value: T,
	ctx: Ctx,
) => void | ValidationIssue | ValidationIssue[] | Promise<void | ValidationIssue | ValidationIssue[]>

export type ValidationSpec<T, Ctx extends ExecCtx = ExecCtx> = {
	schema: Schema
	validate: JsonValidator<T>
	custom: Array<CustomValidator<T, Ctx>>
}

export const passthroughValidator = <T>(): JsonValidator<T> => (value) => ({ ok: true as const, value: value as T })

const decodeJsonPointerToken = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~')

export const pathFromJsonPointer = (raw: string): Array<string | number> | undefined => {
	const p = String(raw ?? '')
	if (!p || p === '/') return undefined
	const parts = p.split('/').filter(Boolean).map(decodeJsonPointerToken)
	const out: Array<string | number> = []
	for (const part of parts) {
		if (/^(0|[1-9]\d*)$/.test(part)) out.push(Number(part))
		else out.push(part)
	}
	return out.length ? out : undefined
}

const issuesFromTypeBoxErrors = (errors: Iterable<ValueError>): ValidationIssue[] => {
	const out: ValidationIssue[] = []
	for (const e of errors) {
		const path = pathFromJsonPointer(e.path)
		out.push({
			message: typeof e.message === 'string' && e.message.trim() ? e.message : 'Invalid value',
			...(path?.length ? { path } : {}),
			code: typeof e.type === 'number' ? String(e.type) : undefined,
		})
	}
	return out.length ? out : [{ message: 'Invalid value' }]
}

const TYPECHECK_CACHE = new WeakMap<object, TypeCheck<any>>()

export const compileValidator = <S extends Schema>(schema: S): JsonValidator<Infer<S>> => {
	const cached = TYPECHECK_CACHE.get(schema as any) as TypeCheck<S> | undefined
	if (cached) {
		return (value: unknown) => {
			const candidate = Value.Default(schema as any, Value.Clone(value))
			const ok = cached.Check(candidate)
			return ok
				? { ok: true as const, value: candidate as Infer<S> }
				: { ok: false as const, issues: issuesFromTypeBoxErrors(cached.Errors(candidate) as any) }
		}
	}

	let tc: TypeCheck<S>
	try {
		tc = TypeCompiler.Compile(schema)
	} catch (e) {
		throw new CmdError('E_INTERNAL', 'Internal error', {
			message: 'Failed to compile TypeBox schema',
			cause: e,
		})
	}
	TYPECHECK_CACHE.set(schema as any, tc as any)
	return (value: unknown) => {
		const candidate = Value.Default(schema as any, Value.Clone(value))
		const ok = tc.Check(candidate)
		return ok
			? { ok: true as const, value: candidate as Infer<S> }
			: { ok: false as const, issues: issuesFromTypeBoxErrors(tc.Errors(candidate) as any) }
	}
}

const JSON_SCHEMA_CACHE = new WeakMap<object, JsonSchema>()

export const toJsonSchema = (schema: Schema): JsonSchema => {
	const cached = JSON_SCHEMA_CACHE.get(schema as any)
	if (cached) return cached
	const out = JSON.parse(JSON.stringify(schema)) as JsonSchema
	JSON_SCHEMA_CACHE.set(schema as any, out)
	return out
}

const STRICT_SCHEMA_CACHE = new WeakMap<object, Schema>()

const SKIP_DEEP_NORMALIZE_KEYS = new Set(['default', 'examples', 'example', 'enum', 'const'])

/**
 * TypeBox defaults `additionalProperties` to `true` for objects.
 *
 * In @pluxel/cmd, object schemas commonly act as "parameter bags" (including nested objects),
 * so we treat `type: "object"` + `properties` as strict-by-default when `additionalProperties`
 * is omitted.
 *
 * To allow unknown keys, set `additionalProperties: true` explicitly (or use `openObj(...)`).
 */
const normalizeSchemaStrictObjects = <S extends Schema>(schema: S): S => {
	if (!schema || typeof schema !== 'object') return schema
	const cached = STRICT_SCHEMA_CACHE.get(schema as any) as S | undefined
	if (cached) return cached

	const memo = new WeakMap<object, unknown>()

	const normalizeNode = (node: unknown): unknown => {
		if (!node || typeof node !== 'object') return node
		if (memo.has(node as any)) return memo.get(node as any)

		if (Array.isArray(node)) {
			let changed = false
			const next: unknown[] = []
			for (let i = 0; i < node.length; i++) {
				const v = node[i]
				const nv = normalizeNode(v)
				if (nv !== v) changed = true
				next.push(nv)
			}
			const out = changed ? next : node
			memo.set(node as any, out)
			return out
		}

		const obj = node as Record<string, unknown>
		const keys = Reflect.ownKeys(obj) as Array<string | symbol>

		const clone = () =>
			Object.create(Object.getPrototypeOf(obj), Object.getOwnPropertyDescriptors(obj)) as Record<string | symbol, unknown>

		let out: Record<string | symbol, unknown> | undefined

		for (const k of keys) {
			const v = (obj as any)[k]
			if (typeof k === 'string' && SKIP_DEEP_NORMALIZE_KEYS.has(k)) continue
			const nv = normalizeNode(v)
			if (nv === v) continue
			out ??= clone()
			out[k] = nv
		}

		const isObjectSchema = obj.type === 'object' && typeof obj.properties === 'object' && obj.properties !== null
		const shouldMakeStrict = isObjectSchema && obj.additionalProperties === undefined
		if (shouldMakeStrict) {
			out ??= clone()
			out.additionalProperties = false
		}

		const normalized = out ?? obj
		memo.set(node as any, normalized)
		return normalized
	}

	const normalized = normalizeNode(schema) as S
	STRICT_SCHEMA_CACHE.set(schema as any, normalized)
	return normalized
}

export const createValidationSpec = <S extends Schema, Ctx extends ExecCtx = ExecCtx>(
	schema: S,
): ValidationSpec<Infer<S>, Ctx> => {
	const normalized = normalizeSchemaStrictObjects(schema)
	return {
		schema: normalized,
		validate: compileValidator(normalized),
		custom: [],
	}
}

export async function validateWithCustom<T>(
	spec: ValidationSpec<T>,
	value: unknown,
	code: Extract<CmdErrorCode, 'E_INPUT_VALIDATION' | 'E_OUTPUT_VALIDATION'>,
	ctx?: ExecCtx,
): Promise<T> {
	throwIfStopped(ctx)
	const base = spec.validate(value)
	if (!base.ok) {
		throw new CmdError(code, code === 'E_INPUT_VALIDATION' ? 'Invalid input' : 'Invalid output', {
			details: { issues: base.issues } as any,
		})
	}

	const customIssues: ValidationIssue[] = []
	if (spec.custom.length) {
		const typed = base.value as any
		for (const v of spec.custom) {
			throwIfStopped(ctx)
			const res = await maybeAwait(v(typed, (ctx ?? {}) as any))
			if (!res) continue
			if (Array.isArray(res)) {
				if (res.length) customIssues.push(...res)
				continue
			}
			customIssues.push(res)
		}
	}

	if (customIssues.length) {
		throw new CmdError(code, code === 'E_INPUT_VALIDATION' ? 'Invalid input' : 'Invalid output', {
			details: { issues: customIssues } as any,
		})
	}

	return base.value
}

export type BeforeResult<S> =
	| { kind: 'continue'; state?: S; candidate?: unknown }
	| { kind: 'shortCircuit'; state?: S; outputCandidate: unknown }

export type AfterOutputResult = { kind: 'transform'; outputCandidate: unknown } | void
export type OnErrorResult = { kind: 'recover'; outputCandidate: unknown } | void

export interface Interceptor<S = unknown> {
	name?: string
	canRecover?: boolean

	before?: (ctx: ExecCtx, candidate: unknown) => BeforeResult<S> | void | Promise<BeforeResult<S> | void>
	afterInput?: (ctx: ExecCtx, input: unknown, state: S | undefined) => void | Promise<void>
	afterOutput?: (
		ctx: ExecCtx,
		outputCandidate: unknown,
		state: S | undefined,
	) => AfterOutputResult | Promise<AfterOutputResult>
	onError?: (ctx: ExecCtx, err: CmdError, state: S | undefined) => OnErrorResult | Promise<OnErrorResult>
	finally?: (ctx: ExecCtx, summary: { ok: boolean; durationMs: number; err?: CmdError }, state: S | undefined) => void | Promise<void>
}

export async function withSpan<T>(
	ctx: ExecCtx | undefined,
	name: string,
	attrs: Record<string, unknown>,
	fn: () => T | Promise<T>,
): Promise<T> {
	if (!ctx?.span) return await fn()
	return await ctx.span(name, attrs, fn)
}

export async function maybeAwait<T>(v: T | PromiseLike<T>): Promise<T> {
	return isPromiseLike(v) ? await v : v
}
