import type { ExecCtx } from '../core'
import type { Infer, Interceptor, Schema } from '../core'
import type { CmdBuilder, TextConfig } from '../cmd'

type Awaitable<T> = T | Promise<T>

type BuilderState = { hasHandle: boolean; hasText: boolean; hasMcp: boolean }
type HandledState<S extends BuilderState> = { hasHandle: true; hasText: S['hasText']; hasMcp: S['hasMcp'] }

const DRAFT_BUILT = Symbol.for('pluxel:cmdkit:kit:draft')

export type BuiltCommandDraft<Ctx extends ExecCtx, R> = {
	readonly [DRAFT_BUILT]: 'command'
	readonly apply: <S extends BuilderState>(
		b: CmdBuilder<any, any, S>,
	) => { builder: CmdBuilder<any, any, HandledState<S>>; text?: Omit<TextConfig, 'triggers'> }
}

export type BuiltOpDraft<Ctx extends ExecCtx, R> = {
	readonly [DRAFT_BUILT]: 'op'
	readonly apply: <S extends BuilderState>(b: CmdBuilder<any, any, S>) => { builder: CmdBuilder<any, any, HandledState<S>> }
}

export type BuiltDraft<Ctx extends ExecCtx = ExecCtx, R = unknown> =
	| BuiltCommandDraft<Ctx, R>
	| BuiltOpDraft<Ctx, R>

type Step = (b: any) => any

export type CommandDraft<Ctx extends ExecCtx, I = unknown> = {
	input<S extends Schema>(schema: S): CommandDraft<Ctx, Infer<S>>
	output<SOut extends Schema>(schema: SOut): CommandDraft<Ctx, I>
	intercept<TState>(itc: Interceptor<TState>): CommandDraft<Ctx, I>
	/** Configure cmd text execution (tail DSL only; triggers are provided by the kit installer). */
	text(cfg?: Omit<TextConfig, 'triggers'>): CommandDraft<Ctx, I>
	/** Handle execution with an explicit object argument (LLM-friendly). */
	handleWith<R>(fn: (args: { input: I; ctx: Ctx }) => Awaitable<R>): BuiltCommandDraft<Ctx, R>
}

export type OpDraft<Ctx extends ExecCtx, I = unknown> = {
	input<S extends Schema>(schema: S): OpDraft<Ctx, Infer<S>>
	output<SOut extends Schema>(schema: SOut): OpDraft<Ctx, I>
	intercept<TState>(itc: Interceptor<TState>): OpDraft<Ctx, I>
	handleWith<R>(fn: (args: { input: I; ctx: Ctx }) => Awaitable<R>): BuiltOpDraft<Ctx, R>
}

function createCommandDraft<Ctx extends ExecCtx, I>(
	steps: readonly Step[],
	text: Omit<TextConfig, 'triggers'> | undefined,
): CommandDraft<Ctx, I> {
	const push = (step: Step, nextText?: Omit<TextConfig, 'triggers'> | undefined) =>
		createCommandDraft<Ctx, I>([...steps, step], nextText === undefined ? text : nextText)

	const buildHandle = <R,>(fn: (input: I, ctx: Ctx) => Awaitable<R>): BuiltCommandDraft<Ctx, R> => {
		const snapSteps = [...steps]
		const snapText = text
		return {
			[DRAFT_BUILT]: 'command' as const,
			apply(b) {
				let cur: any = b
				for (const step of snapSteps) cur = step(cur)
				cur = cur.handle(fn as any)
				return { builder: cur, ...(snapText ? { text: snapText } : {}) }
			},
		}
	}

	return {
		input(schema: any) {
			return createCommandDraft<Ctx, any>([...steps, (b) => b.input(schema)], text)
		},
		output(schema: any) {
			return push((b) => b.output(schema))
		},
		intercept(itc: any) {
			return push((b) => b.intercept(itc))
		},
		text(cfg?: any) {
			return push((b) => b, cfg === undefined ? text : cfg)
		},
		handleWith(fn) {
			return buildHandle((input, ctx) => fn({ input, ctx }))
		},
	}
}

function createOpDraft<Ctx extends ExecCtx, I>(steps: readonly Step[]): OpDraft<Ctx, I> {
	const push = (step: Step) => createOpDraft<Ctx, I>([...steps, step])

	const buildHandle = <R,>(fn: (input: I, ctx: Ctx) => Awaitable<R>): BuiltOpDraft<Ctx, R> => {
		const snapSteps = [...steps]
		return {
			[DRAFT_BUILT]: 'op' as const,
			apply(b) {
				let cur: any = b
				for (const step of snapSteps) cur = step(cur)
				cur = cur.handle(fn as any)
				return { builder: cur }
			},
		}
	}

	return {
		input(schema: any) {
			return createOpDraft<Ctx, any>([...steps, (b) => b.input(schema)])
		},
		output(schema: any) {
			return push((b) => b.output(schema))
		},
		intercept(itc: any) {
			return push((b) => b.intercept(itc))
		},
		handleWith(fn) {
			return buildHandle((input, ctx) => fn({ input, ctx }))
		},
	}
}

export function cmd<Ctx extends ExecCtx>(): CommandDraft<Ctx, unknown> {
	return createCommandDraft<Ctx, any>([], undefined) as any
}

export function op<Ctx extends ExecCtx>(): OpDraft<Ctx, unknown> {
	return createOpDraft<Ctx, any>([]) as any
}

