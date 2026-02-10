import type { Context } from '@pluxel/hmr'
import { formatEtag, normalizeEtag, UniverWorkbooksStore } from './workbooks.store'

const API_PREFIX = '/api/univer'

export function registerUniverWorkbooksHttp(ctx: Context, store: UniverWorkbooksStore): () => void {
	const base = `${API_PREFIX}/workbooks`
	return ctx.honoService.modifyApp((app) => {
		app.get(`${base}/:id/meta`, (c) => {
			const id = c.req.param('id')
			try {
				return c.json(store.openWorkbook(id))
			} catch (error) {
				return c.json({ error: error instanceof Error ? error.message : String(error) }, 404)
			}
		})

		app.get(`${base}/:id/snapshots/:rev`, (c) => {
			const id = c.req.param('id')
			const revRaw = c.req.param('rev')
			const rev = Number(revRaw)
			if (!Number.isFinite(rev) || rev <= 0) return c.json({ error: 'invalid rev' }, 400)
			const snap = store.getSnapshot(id, rev)
			if (!snap) return c.json({ error: 'snapshot not found' }, 404)

			const etagHeader = formatEtag(snap.etag)
			const inm = c.req.header('if-none-match')
			if (inm && normalizeEtag(inm) === normalizeEtag(etagHeader)) {
				c.header('ETag', etagHeader)
				c.header('Cache-Control', 'public, max-age=31536000, immutable')
				return c.body(null, 304)
			}

			c.header('Content-Type', 'application/json; charset=utf-8')
			c.header('ETag', etagHeader)
			c.header('Cache-Control', 'public, max-age=31536000, immutable')
			return c.body(snap.json)
		})

		app.put(`${base}/:id/uploads/:uploadId`, async (c) => {
			const id = c.req.param('id')
			const uploadId = c.req.param('uploadId')
			const token = c.req.query('token') ?? ''
			if (!token) return c.json({ error: 'missing token' }, 401)
			const body = await c.req.text()
			try {
				await store.acceptUpload({ workbookId: id, uploadId, token, json: body })
				return c.json({ ok: true })
			} catch (error) {
				return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
			}
		})
	})
}
