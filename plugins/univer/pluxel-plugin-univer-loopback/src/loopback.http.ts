import type { Context } from '@pluxel/hmr'
import type { UniverLoopbackRunInput, UniverLoopbackRunResult } from '@pluxel/univer-headless/protocol'

const API_PREFIX = '/api/univer'

export function registerUniverLoopbackHttp(
	ctx: Context,
	handler: (input: UniverLoopbackRunInput) => Promise<UniverLoopbackRunResult>,
): () => void {
	const base = `${API_PREFIX}/loopback`
	return ctx.honoService.modifyApp((app) => {
		app.post(`${base}/run`, async (c) => {
			let input: UniverLoopbackRunInput
			try {
				input = (await c.req.json()) as UniverLoopbackRunInput
			} catch (error) {
				return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
			}

			try {
				const res = await handler(input)
				return c.json(res)
			} catch (error) {
				return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
			}
		})
	})
}

