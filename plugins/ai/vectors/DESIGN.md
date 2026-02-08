# Vectors Plugin (Design Notes)

Goal: provide a *minimal* and *composable* vector search surface for Pluxel plugins.

## Non-goals

- Chunking: callers own chunk strategy.
- RAG orchestration: callers (or a separate plugin) own prompt assembly, rerank, citations.
- “Universal metadata filter DSL”: start small; add only when a real cross-backend need appears.

## API shape

- `vectors.scope().index("docs")` → an index handle.
- Index supports:
  - `upsertVectors(...)` / `queryVector(...)`
  - Optional convenience: `upsertTexts(..., { embeddings })` / `queryText(..., { embeddings })`
  - `deleteByIds(...)` (alias: `delete(...)`)

Embedding providers are intentionally *not* baked in:
- Any object that implements `{ embedDocuments(), embedQuery() }` can be used (LangChain embeddings fit).
