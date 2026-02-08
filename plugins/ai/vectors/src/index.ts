export { Vectors } from './core'
export type { VectorsDriver, VectorsIndex, VectorsIndexName, VectorsScope, VectorsScopeKey } from './core'
export type {
	Embedder,
	Vector,
	VectorMetadata,
	VectorsHit,
	VectorsIndexStats,
	VectorsQueryTextInput,
	VectorsQueryVectorInput,
	VectorsUpsertTextItem,
	VectorsUpsertVectorItem,
} from './types'

import { VectorsLanceDb } from './lancedb'
export { VectorsLanceDb } from './lancedb'

/** Default backend provider (LanceDB). */
export { VectorsLanceDb as default } from './lancedb'

/** Convenience export for plugin registration. */
export const plugins = [VectorsLanceDb] as const
