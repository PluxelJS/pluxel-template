import { BasePlugin } from '@pluxel/hmr'

import type {
	Embedder,
	Vector,
	VectorsHit,
	VectorsIndexStats,
	VectorsQueryTextInput,
	VectorsQueryVectorInput,
	VectorsUpsertTextItem,
	VectorsUpsertVectorItem,
} from './types'

export type VectorsIndexName = string
export type VectorsScopeKey = string

export interface VectorsIndex {
	readonly name: string
	stats: () => Promise<VectorsIndexStats>

	upsertVectors: (items: VectorsUpsertVectorItem[]) => Promise<void>
	upsertTexts: (items: VectorsUpsertTextItem[], options: { embeddings: Embedder }) => Promise<void>

	queryVector: (input: VectorsQueryVectorInput) => Promise<VectorsHit[]>
	queryText: (input: VectorsQueryTextInput, options: { embeddings: Embedder }) => Promise<VectorsHit[]>

	/** Delete by ids (best-effort count depending on backend). */
	deleteByIds: (ids: string[]) => Promise<number>
	/** Alias of `deleteByIds`. */
	delete: (ids: string[]) => Promise<number>

	/**
	 * Convenience binder to avoid threading `{ embeddings }` through every call.
	 *
	 * ```ts
	 * const idx = vectors.index('docs').withEmbeddings(embeddings)
	 * await idx.upsertTexts([{ id, text }])
	 * const hits = await idx.queryText({ query, topK: 5 })
	 * ```
	 */
	withEmbeddings: (embeddings: Embedder) => Readonly<{
		upsertTexts: (items: VectorsUpsertTextItem[]) => Promise<void>
		queryText: (input: VectorsQueryTextInput) => Promise<VectorsHit[]>
	}>
}

export interface VectorsScope {
	readonly key: VectorsScopeKey
	index: (name: VectorsIndexName) => VectorsIndex
}

export interface VectorsDriver {
	index: (scopeKey: VectorsScopeKey, indexName: VectorsIndexName) => VectorsIndex
}

export abstract class Vectors extends BasePlugin {
	protected abstract driver(): VectorsDriver

	/** Default: true. Override in providers to allow global (unscoped) indices. */
	protected scopeByCaller(): boolean {
		return true
	}

	protected requireCallerScopeKey(method: string): VectorsScopeKey {
		const callerId = this.ctx.caller?.pluginInfo?.id
		if (!callerId) throw new Error(`[Vectors] ${method}() requires caller context (call it inside a plugin)`)
		return callerId
	}

	/**
	 * Get a scoped view:
	 * - `scope()` uses caller plugin id (recommended).
	 * - `scope('X')` uses explicit scope (scripts/tests/shared namespace).
	 */
	scope(scopeKey?: VectorsScopeKey): VectorsScope {
		const key = scopeKey ?? (this.scopeByCaller() ? this.requireCallerScopeKey('scope') : '')
		const driver = this.driver()
		return {
			key,
			index: (name: string) => driver.index(key, name),
		}
	}

	/** Caller-scope shortcut. */
	index(name: VectorsIndexName, opts?: { scopeKey?: VectorsScopeKey }): VectorsIndex {
		return this.scope(opts?.scopeKey).index(name)
	}

	protected normalizeVector(raw: Vector): number[] {
		if (Array.isArray(raw)) return raw.map((v) => Number(v))
		// Typed arrays and other array-likes.
		return Array.from(raw as ArrayLike<number>, (v) => Number(v))
	}
}
