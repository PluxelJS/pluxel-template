import '@pluxel/hmr/services'
import { describe, expect, it } from 'vitest'
import { withHost } from '@pluxel/test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import Vectors, { VectorsLanceDb } from '../src'

describe('pluxel-plugin-vectors: LanceDB backend', () => {
	it('upserts and queries vectors', async () => {
		await withHost(async (host) => {
			await host.ctx.configService.ready

			host.cfg(VectorsLanceDb).set({
				config: { dbPath: path.join(tmpdir(), `pluxel-vectors-${randomUUID()}`), scopeByCaller: false, tablePrefix: 't' },
			})
			host.add(VectorsLanceDb)
			await host.commit()

			const vectors = host.require(Vectors)

			const idx = vectors.scope('Test').index('docs')
			await idx.upsertVectors([
				{ id: 'a', vector: [1, 0, 0], text: 'A', metadata: { tag: 'x' } },
				{ id: 'b', vector: [0, 1, 0], text: 'B', metadata: { tag: 'y' } },
			])

			const hits = await idx.queryVector({ vector: [1, 0, 0], topK: 1 })
			expect(hits.length).toBe(1)
			expect(hits[0]?.id).toBe('a')
			expect(hits[0]?.text).toBe('A')
		})
	})

	it('supports withEmbeddings() binder for text APIs', async () => {
		await withHost(async (host) => {
			await host.ctx.configService.ready

			host.cfg(VectorsLanceDb).set({
				config: { dbPath: path.join(tmpdir(), `pluxel-vectors-${randomUUID()}`), scopeByCaller: false, tablePrefix: 't' },
			})
			host.add(VectorsLanceDb)
			await host.commit()

			const vectors = host.require(Vectors)
			const idx = vectors.scope('Test').index('docs')

			const embeddings = {
				embedDocuments: async (texts: string[]) => texts.map((t) => (t.includes('A') ? [1, 0, 0] : [0, 1, 0])),
				embedQuery: async (text: string) => (text.includes('A') ? [1, 0, 0] : [0, 1, 0]),
			}

			const bound = idx.withEmbeddings(embeddings)
			await bound.upsertTexts([
				{ id: 'a', text: 'A', metadata: { tag: 'x' } },
				{ id: 'b', text: 'B', metadata: { tag: 'y' } },
			])

			const hits = await bound.queryText({ query: 'A', topK: 1 })
			expect(hits[0]?.id).toBe('a')
		})
	})
})
