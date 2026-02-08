# LangChain Plugin (Design Notes)

Goal: expose a *small* and *stable* LangChain integration surface for Pluxel plugins.

## Layering

- `pluxel-plugin-llm-hub`: profiles + Vault keys + routing + circuit breaker
- `pluxel-plugin-langchain`: model factories (LangChain) driven by `LLMConnection`

This avoids turning the hub into an LLM framework, while still giving downstream plugins an ergonomic “just give me a model” API.

## Public API (minimal)

- `await lc.chatModel({ llm?, provider?, model?, params? }) -> BaseChatModel`
- `await lc.embeddings({ llm?, provider?, model?, params? }) -> EmbeddingsInterface`
- With meta: `await lc.resolveChat(...)` / `await lc.resolveEmbeddings(...)`
- Advanced (avoid extra routing/Vault read): `await lc.chatModelFromConnection(conn)` / `await lc.embeddingsFromConnection(conn)`
- Advanced with meta: `await lc.resolveChatFromConnection(conn)` / `await lc.resolveEmbeddingsFromConnection(conn)`

Plus:
- `lc.register*Factory(providerId, factory)` for ecosystem extension without forking the plugin.

## Sessions (optional)

This plugin does **not** persist prompts by default.

We provide lightweight helpers in `pluxel-plugin-langchain/sessions` to:
- create an in-memory message history store keyed by `sessionId`
- wrap a runnable/model with message-history in a LangChain-native way

Persistence can be built as a separate plugin on top (KV / DB) without changing the core API.
