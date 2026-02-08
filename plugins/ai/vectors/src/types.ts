export type Vector = ReadonlyArray<number> | Float32Array

export type VectorMetadata = Readonly<Record<string, unknown>>

export type Embedder = Readonly<{
	embedDocuments: (texts: string[]) => Promise<number[][]>
	embedQuery: (text: string) => Promise<number[]>
}>

export type VectorsUpsertVectorItem = Readonly<{
	id: string
	vector: Vector
	text?: string
	metadata?: VectorMetadata
}>

export type VectorsUpsertTextItem = Readonly<{
	id: string
	text: string
	metadata?: VectorMetadata
}>

export type VectorsQueryVectorInput = Readonly<{
	vector: Vector
	topK?: number
	includeVector?: boolean
}>

export type VectorsQueryTextInput = Readonly<{
	query: string
	topK?: number
	includeVector?: boolean
}>

export type VectorsHit = Readonly<{
	id: string
	/** Backend-specific distance (smaller usually means closer). */
	distance?: number
	text?: string
	metadata?: VectorMetadata
	vector?: number[]
}>

export type VectorsIndexStats = Readonly<{
	name: string
	dimension?: number
	count?: number
}>

