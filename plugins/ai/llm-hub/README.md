# pluxel-plugin-llm-hub

LLM provider hub plugin for the Pluxel/HMR runtime (profiles + routing + circuit breaker).

Design:
- Provider profiles are data-driven (pluginData) and API keys live in Vault.
- UI is optional but included for managing profiles (no hard-coded config provider settings).
- Profiles support **priority** + **circuit breaker** for availability-aware fallback routing.

This hub is **SDK-agnostic**. It exposes one core concept:

- `LLMConnection = { profile, apiKey, fetch }`

That shape intentionally matches common ecosystem expectations (baseURL + apiKey + fetch middleware),
so you can plug it into standards like **Vercel AI SDK** without this hub hard-binding to any one LLM library.

## Quick usage

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { LLM } from 'pluxel-plugin-llm-hub'

@Plugin({ name: 'MyPlugin' })
export class MyPlugin extends BasePlugin {
	constructor(private readonly llm: LLM) {
		super()
	}

	override async init() {
		const conn = await this.llm.connection()
		this.ctx.logger.info('llm conn profile', conn.profile)
	}
}
```

Note: host/tests may import the concrete implementation `LLMHub` from this package. Business plugins should still inject the `LLM` token.

## Setup (host)

1) Enable the hub plugin in your profile (e.g. `pluxel.hmr.jsonc`):

```jsonc
{
  "hmrService": {
    "entries": [
      // ...
      "pluxel-plugin-llm-hub"
    ]
  }
}
```

2) Open the `LLM` tab in the host UI and create at least one profile (provider/model/baseURL + apiKey in Vault).

## Routing: priority + circuit breaker

When `profileId` is omitted, `llm.connection()` selects a profile deterministically:

- Candidate set: `enabled: true` profiles
- Sort order: higher `priority` first, then newer `updatedAt`
- Fallback: if the current candidate is unusable (missing key / circuit open), it will fall back to the next candidate by default
- Circuit breaker: failures (HTTP 429/5xx and network errors) are tracked per profile and can temporarily open the circuit

Per-call overrides:
- `allowFallback: false` disables fallback for this call only.
- `allowCircuitOpen: true` allows selecting an open circuit (useful for “probe to recover”).

```ts
const conn = await llm.connection({ allowFallback: false })
const forceProbe = await llm.connection({ profileId: '...', allowCircuitOpen: true })
```

When to disable fallback (`allowFallback: false`):
- You need strong consistency (one request must stick to one provider/profile).
- You want failures to be loud (e.g. tests, admin actions, migrations).
- You are doing multi-step flows that depend on upstream state (some providers have subtle per-session behaviors).

You can edit these in the LLM web UI tab:
- per-profile: `priority`, circuit knobs, and a one-click "reset health"
- global: default circuit config

If you prefer explicit error handling (Result-style), use:

```ts
const res = await llm.connectionResult()
if (!res.ok) {
  // res.err.code / res.err.message
  // res.err.details may include:
  // - { profileId } for missing key / circuit open
  // - { openUntil } for circuit open
  // - { tried: [...] } when all candidates are unavailable
  throw new Error(res.err.message)
}
const conn = res.val
```

## Generic connection (SDK-agnostic)

If you want to use *other* SDKs (not just Ax), resolve a generic connection:

```ts
import type { LLM } from 'pluxel-plugin-llm-hub'

async function demo(llm: LLM) {
	const conn = await llm.connection()
	// conn.profile.provider / model / baseURL / config / options
	// conn.apiKey (sensitive; never log/persist)
	// conn.fetch (instrumented: circuit breaker + health tracking)
}
```

This is intentionally close to common ecosystem conventions:
- `profile.baseURL` is the upstream base URL (OpenAI-compatible proxies, self-hosted endpoints, etc.).
- `conn.fetch` is the single extension point for future cross-cutting features (usage accounting, tracing, retry, rate-limiters).

## Vercel AI SDK (recommended)

Vercel AI SDK is a good “community standard” to target because it normalizes the **call surface** (model, tools, streaming, usage).

Install:

```sh
pnpm add ai @ai-sdk/openai
```

Example: OpenAI (or OpenAI-compatible) via `@ai-sdk/openai`:

```ts
import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'
import type { LLM } from 'pluxel-plugin-llm-hub'
import { toAISDKProviderOptions } from 'pluxel-plugin-llm-hub/aisdk'

async function run(llm: LLM) {
	const conn = await llm.connection()
	const openai = createOpenAI(toAISDKProviderOptions(conn))

	const modelId = conn.profile.model ?? 'gpt-4o-mini'
	const model = openai(modelId as any)

	const out = await generateText({ model, prompt: 'hi' })
	return out.text
}
```

Notes:
- For other providers, swap the AI SDK provider package (e.g. `@ai-sdk/anthropic`, etc.) and keep using the same `conn`.
- `conn.fetch` is the right place to add future usage accounting hooks (timing/status), while usage tokens are best taken from the SDK’s own result object when available.

## Ax LLM (optional adapter)

If you prefer Ax (signatures, agents, function tools), keep it as an **adapter**, not the hub’s center:

Install:

```sh
pnpm add @ax-llm/ax
```

```ts
import { ax } from '@ax-llm/ax'
import type { LLM } from 'pluxel-plugin-llm-hub'
import { createAxAIFromConnection } from 'pluxel-plugin-llm-hub/adapters/ax'

async function run(llm: LLM) {
	// `purpose: 'loopback'` enforces deterministic + compat-friendly defaults (e.g. no streaming).
	const ai = createAxAIFromConnection(await llm.connection(), { purpose: 'loopback' })
	return await ax('msg:string -> out:string').forward(ai, { msg: 'hi' })
}
```

If you need protocol-specific capabilities in Ax (example: OpenAI Responses API), you can override the Ax provider name
without changing the hub surface:

```json
{
  "axProvider": "openai-responses"
}
```

## TOON (optional structured context encoder)

If you need to feed large structured context (tables/lists) into an LLM efficiently, use:

```ts
import { formatStructured } from '@pluxel/promptkit/toon'

const ctx = formatStructured(rows, { format: 'toon' })
// ctx.text -> put into prompt
// ctx.contentType -> "text/toon; charset=utf-8"
```

## Tracing (headers)

If you pass `traceId` / `sessionId` into `llm.connection({ traceId, sessionId })`, the hub will best-effort propagate:

- `x-pluxel-trace-id`
- `x-pluxel-session-id`

into upstream HTTP requests (via the instrumented `fetch`). This keeps the surface small while leaving room for future usage accounting (per-trace/session aggregation).

## Usage accounting (future)

This hub intentionally does **not** try to guess token usage from provider-specific responses today.

The recommended direction is:
- Treat `conn.fetch` as the single choke-point for request timing + status accounting.
- Use `traceId/sessionId` (propagated headers) to correlate usage at a higher layer (gateway, proxy, or OTLP exporter).

## Debugging (timeout-safe Host snippet)

When running ad-hoc Node debug scripts, the process may stay alive due to open handles from runtime services.
Use a hard timeout (and log `startError`/`resolveError`) so you never get stuck:

```ts
import { withHost } from '@pluxel/test'
import { LLMHub } from 'pluxel-plugin-llm-hub'

const kill = setTimeout(() => process.exit(124), 15_000)
kill.unref()

await withHost(async (host) => {
	host.ctx.on('startError', (pluginCtx, err) => {
		console.error('[startError]', pluginCtx.pluginInfo.id, err.stack || err.message)
	})
	host.ctx.on('resolveError', (id, err) => {
		console.error('[resolveError]', String(id), err.stack || err.message)
	})

	host.add(LLMHub)
	await host.commitAllowFail()
})
```
