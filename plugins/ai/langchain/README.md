# pluxel-plugin-langchain

LangChain.js adapter plugin for the Pluxel/HMR runtime.

This plugin is intentionally **thin**:

- `pluxel-plugin-llm-hub` owns profiles + Vault API keys + routing + circuit breaker
- `pluxel-plugin-langchain` turns an `LLMConnection` into LangChain models (chat / embeddings)

## Usage

## Setup (host)

Enable both plugins in `pluxel.hmr.jsonc`:

```jsonc
{
  "hmrService": {
    "entries": [
      "pluxel-plugin-llm-hub",
      "pluxel-plugin-langchain"
    ]
  }
}
```

Note: host/tests may import the concrete implementation `LangChainService` from this package. Business plugins should inject the `LangChain` token.

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { LangChain } from 'pluxel-plugin-langchain'

@Plugin({ name: 'MyPlugin' })
export class MyPlugin extends BasePlugin {
	constructor(private readonly lc: LangChain) {
		super()
	}

	override async init() {
		const chat = await this.lc.chatModel()
		const out = await chat.invoke('hi')
		this.ctx.logger.info('lc out', { out })
	}
}
```

Notes:
- When `profileId` is omitted, routing is handled by `pluxel-plugin-llm-hub` via `priority` + fallback.
- The created LangChain models always use the hub’s instrumented `conn.fetch` (circuit breaker + health tracking + headers).
- If you need meta (effective provider/model), use `lc.resolveChat()` / `lc.resolveEmbeddings()`.

Example with meta:

```ts
const { model: chat, meta } = await this.lc.resolveChat({ llm: { traceId: 't1', sessionId: 's1' } })
this.ctx.logger.info('llm selected', meta)
const out = await chat.invoke('hi')
```

## Advanced: reuse a resolved connection

If you already resolved a connection (to guarantee profile consistency, avoid a second Vault read, etc.):

```ts
import { LLM } from 'pluxel-plugin-llm-hub'
import { LangChain } from 'pluxel-plugin-langchain'

async function run(llm: LLM, lc: LangChain) {
	const conn = await llm.connection({ traceId: 't1', sessionId: 's1' })
	const chat = await lc.chatModelFromConnection(conn)
	return await chat.invoke('hi')
}
```

If you also want meta:

```ts
const { model: chat, meta } = await lc.resolveChatFromConnection(conn)
// meta.llmProfile / meta.effective
```
