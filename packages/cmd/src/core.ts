import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import { toJsonSchema } from '@valibot/to-json-schema'

export type CmdErrorCode =
	| 'E_CMD_NOT_FOUND'
	| 'E_ARGV_PARSE'
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

export type CmdErrorDetailsByCode = {
	E_CMD_NOT_FOUND?: { text?: string; tokens?: string[] }
	E_ARGV_PARSE?: { unknownFlags?: Record<string, Array<string | boolean>> }
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
	 * (e.g. wrap a DB/network error into `E_DEPENDENCY`), before cmdkit falls
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

export type VSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> & {
	readonly '~standard': StandardSchemaV1.Props<Input, Output> & {
		readonly jsonSchema?: StandardJSONSchemaV1.Converter
	}
}

export type AnyStdSchema = VSchema<any, any>
export type InferOut<S extends AnyStdSchema> =
	NonNullable<S['~standard']['types']> extends { output: infer O } ? O : unknown

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

export async function validateSchema<S extends AnyStdSchema>(
	schema: S,
	value: unknown,
	code: Extract<CmdErrorCode, 'E_INPUT_VALIDATION' | 'E_OUTPUT_VALIDATION'>,
	ctx?: ExecCtx,
): Promise<InferOut<S>> {
	throwIfStopped(ctx)
	const std = schema?.['~standard']
	if (!std || typeof std.validate !== 'function') {
		throw new CmdError('E_INTERNAL', 'Internal error', {
			message: 'Invalid schema: missing ~standard.validate',
		})
	}
	const raw = std.validate(value)
	const res = (isPromiseLike(raw) ? await raw : raw) as any
	if (!res?.issues || (Array.isArray(res.issues) && res.issues.length === 0)) return res.value as InferOut<S>

	throw new CmdError(code, code === 'E_INPUT_VALIDATION' ? 'Invalid input' : 'Invalid output', {
		details: { issues: toValidationIssues(res.issues) } as any,
	})
}

export function toValidationIssues(raw: unknown): ValidationIssue[] {
	if (!Array.isArray(raw)) return [{ message: 'Invalid value' }]
	return raw.map((it: any) => {
		const path = Array.isArray(it?.path)
			? it.path
					.map((seg: any) => (typeof seg?.key === 'string' || typeof seg?.key === 'number' ? seg.key : undefined))
					.filter((x: any) => x !== undefined)
			: undefined
		return {
			message: typeof it?.message === 'string' ? it.message : 'Invalid value',
			...(path?.length ? { path: path as Array<string | number> } : {}),
		} satisfies ValidationIssue
	})
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

export type StrictEmptyObject = Record<string, never>

export const STRICT_EMPTY_OBJECT_SCHEMA: VSchema<StrictEmptyObject, StrictEmptyObject> = {
	'~standard': {
		version: 1,
		vendor: 'pluxel',
		types: { input: {} as StrictEmptyObject, output: {} as StrictEmptyObject },
		validate(value: unknown) {
			const ok = !!value && typeof value === 'object' && !Array.isArray(value)
			if (!ok) return { issues: [{ message: 'Expected object' }] }
			const keys = Object.keys(value as any)
			if (keys.length !== 0) return { issues: [{ message: 'Expected empty object' }] }
			return { value: value as StrictEmptyObject }
		},
		jsonSchema: {
			input: () => ({ type: 'object', properties: {}, additionalProperties: false }),
			output: () => ({ type: 'object', properties: {}, additionalProperties: false }),
		},
	},
} satisfies VSchema

const INPUT_JSON_SCHEMA_CACHE = new WeakMap<object, Record<string, unknown> | null>()

export const getInputJsonSchema = (schema: AnyStdSchema): Record<string, unknown> | undefined => {
	const cached = INPUT_JSON_SCHEMA_CACHE.get(schema as any)
	if (cached !== undefined) return cached ?? undefined
	try {
		const std = schema['~standard']
		const conv = (std as any)?.jsonSchema?.input
		const out =
			typeof conv === 'function' ? (conv({ target: 'draft-07' }) as any) : (toJsonSchema(schema as any) as any)
		INPUT_JSON_SCHEMA_CACHE.set(schema as any, out)
		return out
	} catch {
		INPUT_JSON_SCHEMA_CACHE.set(schema as any, null)
		return undefined
	}
}

export async function withSpan<T>(ctx: ExecCtx | undefined, name: string, attrs: Record<string, unknown>, fn: () => T | Promise<T>): Promise<T> {
	if (!ctx?.span) return await fn()
	return await ctx.span(name, attrs, fn)
}
