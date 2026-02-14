import type { CmdError, ExecCtx } from './core'
import type { TextToken } from './tokenize'
import type { Result } from './result'

export type TextInvocation = {
	/**
	 * Optional original text.
	 *
	 * Present for `exec.execText(text)` and `router.dispatch(text)`, but may be missing
	 * for `router.dispatchTokens(tokens)` / `router.matchTokens(tokens)`.
	 */
	text?: string
	tokens: TextToken[]
	consumed: number
}

export type TextRunner<Ctx extends ExecCtx = ExecCtx> = (inv: TextInvocation, ctx?: Ctx) => Promise<Result<unknown, CmdError>>

export const CMDKIT_TEXT_RUNNER = Symbol.for('pluxel:cmdkit:text-runner')
