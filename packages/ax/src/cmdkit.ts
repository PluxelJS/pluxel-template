import type { AxFunction } from '@ax-llm/ax'
import type { CmdError, DocContext, ExecCtx, McpExecutable } from '@pluxel/cmd'
import { resolveText } from '@pluxel/cmd'

const cmdErrPayload = (err: CmdError) => ({
	error: {
		name: err.name,
		code: err.code,
		message: err.publicMessage,
		kind: err.kind,
		...(err.details !== undefined ? { details: err.details } : {}),
	},
	})

export function cmdExecutableToAxFunction(
	exec: McpExecutable<any, any>,
	opts?: { docCtx?: DocContext; execCtx?: ExecCtx | ((args: unknown, extra: unknown) => ExecCtx | undefined) },
): AxFunction {
	const meta = exec.mcp
	const docCtx = opts?.docCtx ?? {}

	const name = String(meta.name).trim()
	const description = resolveText(meta.description as any, docCtx)
	const parameters = (meta as any).inputSchema ?? { type: 'object', properties: {} }

	return {
		name,
		description,
		parameters,
		func: async (args: any, extra: any) => {
			let ctx = typeof opts?.execCtx === 'function' ? await (opts.execCtx as any)(args, extra) : opts?.execCtx

			// Default best-effort meta propagation (keeps cmdkit core decoupled from Ax).
			if (!ctx && extra && typeof extra === 'object') {
				const sessionId = (extra as any).sessionId
				const traceId = (extra as any).traceId
				const metaFromExtra: Record<string, unknown> = {}
				if (typeof sessionId === 'string' && sessionId.trim()) metaFromExtra.sessionId = sessionId
				if (typeof traceId === 'string' && traceId.trim()) metaFromExtra.traceId = traceId
				if (Object.keys(metaFromExtra).length) ctx = { meta: metaFromExtra }
			}

			try {
				const res = await exec.exec(args, ctx)
				return res.ok ? res.val : cmdErrPayload(res.err)
			} catch (e: any) {
				const message = typeof e?.message === 'string' ? e.message : String(e)
				return { error: { code: 'INTERNAL', message } }
			}
		},
	} as any
}
