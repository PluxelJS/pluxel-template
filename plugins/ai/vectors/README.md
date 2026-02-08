# pluxel-plugin-vectors

Vector search service plugin for the Pluxel/HMR runtime.

Default backend: **LanceDB** (embedded, local folder).

Design goals:
- Small, stable API for other plugins to consume.
- Caller-scoped by default (`ctx.caller.pluginInfo.id`) to avoid cross-plugin collisions.
- Backend can be swapped later without changing consumer code (DI token = `Vectors`).

Note: host/tests may import the concrete backend implementation `VectorsLanceDb` from this package. Business plugins should inject the `Vectors` token.

## Setup (host)

Enable the plugin in `pluxel.hmr.jsonc`:

```jsonc
{
  "hmrService": {
    "entries": [
      "pluxel-plugin-vectors"
    ]
  }
}
```

Optional config:

```jsonc
{
  "plugins": {
    "Vectors": {
      "config": {
        "dbPath": "./data/vectors",
        "tablePrefix": "",
        "scopeByCaller": true,
        "distanceType": "cosine",
        "autoCreateVectorIndex": true
      }
    }
  }
}
```

## Use (raw vectors)

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { Vectors } from 'pluxel-plugin-vectors'

@Plugin({ name: 'MyPlugin' })
export class MyPlugin extends BasePlugin {
	constructor(private readonly vectors: Vectors) {
		super()
	}

	override async init() {
		const idx = this.vectors.index('docs')
		await idx.upsertVectors([{ id: 'a', vector: [1, 0, 0], text: 'hello', metadata: { docId: 'd1' } }])
		const hits = await idx.queryVector({ vector: [1, 0, 0], topK: 5 })
		this.ctx.logger.info('hits', { hits })
	}
}
```

If you need an explicit scope (scripts/tests/shared namespace):

```ts
const idx = vectors.index('docs', { scopeKey: 'Test' })
```

## Use (texts + embeddings)

This plugin is embedding-provider agnostic. Any `embeddings` object with:

- `embedDocuments(texts) -> number[][]`
- `embedQuery(text) -> number[]`

works (LangChain embeddings fits).

If you use the LangChain example below, also enable `pluxel-plugin-langchain` in your host profile.

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { LangChain } from 'pluxel-plugin-langchain'
import { Vectors } from 'pluxel-plugin-vectors'

@Plugin({ name: 'Rag' })
export class Rag extends BasePlugin {
	constructor(
		private readonly lc: LangChain,
		private readonly vectors: Vectors,
	) {
		super()
	}

	override async init() {
		const embeddings = await this.lc.embeddings({ llm: { profileId: 'your-embeddings-profile-id' } })
		const idx = this.vectors.index('docs').withEmbeddings(embeddings)

		await idx.upsertTexts([{ id: 'c1', text: 'chunk text', metadata: { docId: 'd1' } }])
		const hits = await idx.queryText({ query: 'what is ...?', topK: 5 })
		this.ctx.logger.info('hits', { hits })
	}
}
```

Tip: if you call text APIs frequently, bind embeddings once:

```ts
const idx = this.vectors.index('docs').withEmbeddings(embeddings)
await idx.upsertTexts([{ id: 'c1', text: 'chunk text' }])
const hits = await idx.queryText({ query: '...', topK: 5 })
```

## LanceDB notes

- `metadata` is stored as a JSON string (to avoid schema-evolution issues when new keys appear).
- Vector dimension is fixed per index/table; mixing dimensions will throw.
- Recommended practice: use a separate index name per embeddings model/version to avoid accidental dimension mismatch.
