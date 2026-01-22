import type { CmdError, ExecCtx } from './core'
import type { Result } from './result'

export type TextRunner<Ctx extends ExecCtx = ExecCtx> = (tokens: string[], consumed: number, ctx?: Ctx) => Promise<Result<unknown, CmdError>>

export const CMDKIT_TEXT_RUNNER = Symbol.for('pluxel:cmdkit:text-runner')

