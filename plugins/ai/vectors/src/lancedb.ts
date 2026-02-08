import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { __registerConfigSchema__ as registerConfigSchema, type Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import * as lancedb from '@lancedb/lancedb'

import { Vectors } from './core'
import type { VectorsIndex } from './core'
import type {
	Embedder,
	VectorsHit,
	VectorsIndexStats,
	VectorsQueryTextInput,
	VectorsQueryVectorInput,
	VectorsUpsertTextItem,
	VectorsUpsertVectorItem,
} from './types'

export const VectorsLanceDbConfigSchema = v.object({
	/** Local folder path for LanceDB (created if missing). */
	dbPath: v.optional(v.string(), './data/vectors'),
	/**
	 * Default: true.
	 * When enabled, `scope()` (without args) uses caller plugin id as prefix.
	 */
	scopeByCaller: v.optional(v.boolean(), true),
	/** Optional table prefix for multi-app sharing. */
	tablePrefix: v.optional(v.string(), ''),
	/** Default distance type for vector search. */
	distanceType: v.optional(v.picklist(['cosine', 'l2', 'dot']), 'cosine'),
	/** Default: true. Creates a vector index on first write (best-effort). */
	autoCreateVectorIndex: v.optional(v.boolean(), true),
})

export type VectorsLanceDbConfig = Config<typeof VectorsLanceDbConfigSchema>

type LanceConnection = Awaited<ReturnType<typeof lancedb.connect>>
type LanceTable = Awaited<ReturnType<LanceConnection['openTable']>>

function assertNonEmptyFiniteVector(vec: number[], label: string): void {
	if (!Array.isArray(vec) || vec.length === 0) throw new Error(`[Vectors] ${label}: vector must be non-empty`)
	for (const n of vec) {
		if (typeof n !== 'number' || !Number.isFinite(n)) {
			throw new Error(`[Vectors] ${label}: vector contains non-finite number`)
		}
	}
}

function normalizePart(raw: string): string {
	return String(raw ?? '')
		.trim()
		.replaceAll(/[^a-zA-Z0-9_]+/g, '_')
		.replaceAll(/_+/g, '_')
		.replaceAll(/^_+|_+$/g, '')
}

function toTableName(prefix: string, scopeKey: string, indexName: string): string {
	const parts = [normalizePart(prefix), normalizePart(scopeKey), normalizePart(indexName)].filter(Boolean)
	const joined = parts.join('_')
	if (!joined) throw new Error('[Vectors] invalid index name (empty after normalization)')
	return joined
}

@Plugin(Vectors, { name: 'Vectors', type: 'service' })
export class VectorsLanceDb extends Vectors {
	private config: VectorsLanceDbConfig = this.configs.use(VectorsLanceDbConfigSchema)

	// Shared state must live on the root instance (not caller-injected views).
	private conn: LanceConnection | undefined
	private tables = new Map<string, Promise<LanceTable>>()
	private vectorIndexEnsured = new Set<string>()

	protected override scopeByCaller(): boolean {
		return this.config.scopeByCaller !== false
	}

	protected override init(): void {
		// Validate config early (no IO).
		this.resolveDbPath()
		this.ctx.logger.info('ready')
	}

	protected override stop(): void {
		try {
			this.conn?.close()
		} catch {
			/* best-effort */
		}
		this.conn = undefined
		this.tables.clear()
		this.vectorIndexEnsured.clear()
	}

	private __root(): VectorsLanceDb {
		const proto = Object.getPrototypeOf(this) as unknown
		return proto instanceof VectorsLanceDb ? (proto as VectorsLanceDb) : this
	}

	private resolveDbPath(): string {
		const raw = String(this.config.dbPath ?? '').trim()
		if (!raw) throw new Error('[Vectors] missing config: dbPath')
		return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw)
	}

	private async ensureConn(): Promise<LanceConnection> {
		const root = this.__root()
		if (root.conn) return root.conn

		const dbPath = root.resolveDbPath()
		await mkdir(dbPath, { recursive: true })
		root.conn = await lancedb.connect(dbPath)
		return root.conn
	}

	private async getTableForRead(tableName: string): Promise<LanceTable | null> {
		const root = this.__root()
		const existing = root.tables.get(tableName)
		if (existing) return await existing

		const conn = await root.ensureConn()
		try {
			const table = await conn.openTable(tableName)
			root.tables.set(tableName, Promise.resolve(table))
			return table
		} catch {
			return null
		}
	}

	private async getTableForWrite(
		tableName: string,
		initialRows: Array<Record<string, unknown>>,
	): Promise<{ table: LanceTable; created: boolean }> {
		const root = this.__root()
		const existing = root.tables.get(tableName)
		if (existing) return { table: await existing, created: false }

		let created = false
		const p = (async () => {
			const conn = await root.ensureConn()
			try {
				return await conn.openTable(tableName)
			} catch {
				if (initialRows.length === 0) throw new Error(`[Vectors] index not found: ${tableName}`)
				created = true
				try {
					return await conn.createTable(tableName, initialRows)
				} catch (e) {
					// Best-effort race recovery: another writer may have created the table.
					created = false
					return await conn.openTable(tableName)
				}
			}
		})()

		root.tables.set(tableName, p)
		try {
			return { table: await p, created }
		} catch (e) {
			root.tables.delete(tableName)
			throw e
		}
	}

	private async upsertRows(table: LanceTable, rows: Array<Record<string, unknown>>): Promise<void> {
		if (rows.length === 0) return
		await table
			.mergeInsert('id')
			.whenMatchedUpdateAll()
			.whenNotMatchedInsertAll()
			.execute(rows)
	}

	private async ensureVectorIndex(tableName: string, table: LanceTable): Promise<void> {
		const root = this.__root()
		if (root.vectorIndexEnsured.has(tableName)) return
		root.vectorIndexEnsured.add(tableName)

		if (this.config.autoCreateVectorIndex === false) return
		try {
			await table.createIndex('vector', {
				config: lancedb.Index.hnswSq({ distanceType: this.config.distanceType as any }),
			})
		} catch {
			// best-effort
		}
	}

	protected override driver() {
		const self = this
		return {
			index(scopeKey: string, indexName: string): VectorsIndex {
				const cfg = self.config
				const tableName = toTableName(cfg.tablePrefix, scopeKey, indexName)
				const indexLabel = `${scopeKey || '_'}:${indexName}`

				const stats = async (): Promise<VectorsIndexStats> => {
					const table = await self.getTableForRead(tableName)
					if (!table) return { name: indexName, count: 0 }
					try {
						const count = await table.countRows()
						const schema = await table.schema()
						const vectorField = schema.fields.find((f) => f.name === 'vector')
						const dim = typeof (vectorField as any)?.type?.listSize === 'number' ? (vectorField as any).type.listSize : undefined
						return { name: indexName, count, ...(dim ? { dimension: dim } : {}) }
					} catch {
						return { name: indexName }
					}
				}

				const upsertVectors = async (items: VectorsUpsertVectorItem[]) => {
					if (items.length === 0) return
					const now = Date.now()
					let dim: number | null = null
					const rows = items.map((it) => {
						const vector = self.normalizeVector(it.vector)
						assertNonEmptyFiniteVector(vector, `upsertVectors(${indexLabel}) item ${String(it.id)}`)
						if (dim === null) dim = vector.length
						else if (vector.length !== dim) {
							throw new Error(
								`[Vectors] upsertVectors(${indexLabel}): inconsistent vector dimension in batch (expected ${dim}, got ${vector.length}, id=${String(it.id)})`,
							)
						}
						return {
							id: String(it.id),
							vector,
							text: String(it.text ?? ''),
							metadata: JSON.stringify(it.metadata ?? {}),
							updatedAt: now,
						}
					})
					const { table, created } = await self.getTableForWrite(tableName, rows)
					if (!created) await self.upsertRows(table, rows)
					await self.ensureVectorIndex(tableName, table)
				}

				const upsertTexts = async (items: VectorsUpsertTextItem[], options: { embeddings: Embedder }) => {
					const texts = items.map((x) => String(x.text ?? ''))
					const vectors = await options.embeddings.embedDocuments(texts)
					if (!Array.isArray(vectors) || vectors.length !== items.length) {
						throw new Error('[Vectors] embedDocuments returned an invalid shape')
					}
					await upsertVectors(
						items.map((it, i) => ({
							id: it.id,
							text: it.text,
							metadata: it.metadata,
							vector: vectors[i] ?? [],
						})),
					)
				}

				const queryVector = async (input: VectorsQueryVectorInput): Promise<VectorsHit[]> => {
					const table = await self.getTableForRead(tableName)
					if (!table) return []

					const topK = typeof input.topK === 'number' && Number.isFinite(input.topK) ? Math.max(1, Math.trunc(input.topK)) : 10
					const cols = input.includeVector ? ['id', 'text', 'metadata', 'vector', '_distance'] : ['id', 'text', 'metadata', '_distance']
					const queryVector = self.normalizeVector(input.vector)
					assertNonEmptyFiniteVector(queryVector, `queryVector(${indexLabel})`)
					const q = table.vectorSearch(queryVector).distanceType(cfg.distanceType as any).limit(topK).select(cols)
					const rows = await q.toArray()
					return rows.map((r: any) => ({
						id: String(r.id ?? ''),
						distance: typeof r._distance === 'number' ? r._distance : typeof r.distance === 'number' ? r.distance : undefined,
						text: typeof r.text === 'string' ? r.text : undefined,
						metadata: (() => {
							if (typeof r.metadata === 'string') {
								try {
									const parsed = JSON.parse(r.metadata)
									return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as any) : undefined
								} catch {
									return undefined
								}
							}
							return undefined
						})(),
						vector:
							input.includeVector && Array.isArray(r.vector)
								? (r.vector as number[])
								: undefined,
					}))
				}

				const queryText = async (input: VectorsQueryTextInput, options: { embeddings: Embedder }) => {
					const v = await options.embeddings.embedQuery(String(input.query ?? ''))
					return await queryVector({ vector: v, topK: input.topK, includeVector: input.includeVector })
				}

				const del = async (ids: string[]): Promise<number> => {
					const table = await self.getTableForRead(tableName)
					if (!table) return 0
					if (!ids.length) return 0
					// LanceDB delete API: table.delete("id IN (...)") or delete({ ... }).
					// Use a conservative string filter for now.
					const escape = (s: string) => s.replaceAll("'", "''")
					const quoted = ids.map((id) => `'${escape(String(id))}'`).join(', ')
					const expr = `id IN (${quoted})`
					await table.delete(expr)
					return ids.length
				}

				return {
					name: indexName,
					stats,
					upsertVectors,
					upsertTexts,
					queryVector,
					queryText,
					deleteByIds: del,
					delete: del,
					withEmbeddings: (embeddings: Embedder) => ({
						upsertTexts: (items: VectorsUpsertTextItem[]) => upsertTexts(items, { embeddings }),
						queryText: (input: VectorsQueryTextInput) => queryText(input, { embeddings }),
					}),
				}
			},
		}
	}
}

registerConfigSchema(VectorsLanceDb, 'config', VectorsLanceDbConfigSchema)
