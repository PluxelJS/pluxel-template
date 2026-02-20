# LLM Hub Plugin (Design Notes)

Goal: expose a *small* and *composable* LLM service for the Pluxel/HMR plugin runtime.

## Core ideas

- **Single runtime token**: other plugins depend on `LLM` and do not care about the backing provider.
- **Profiles are data**, not code:
  - provider/model/baseURL/options/config stored in pluginData (`signaldb` collection).
  - API keys stored in Vault (never in pluginData).
- **SDK-agnostic core**:
  - The hub exports `LLMConnection = { profile, apiKey, fetch }`.
  - Callers decide which ecosystem SDK to use (Vercel AI SDK, Ax, raw fetch, etc.).
  - The hub is responsible for managing config + keys + routing + circuit breaker only.
- **Availability-aware routing**:
  - profiles have `priority` for fallback ordering
  - per-profile circuit breaker tracks failures and can temporarily mark a profile unavailable
  - routing is deterministic and UI-managed via `priority` (no “default” concept)

## Layering (plugin perspective)

This plugin is intentionally split into layers to keep the “hub” from turning into an LLM framework:

- `LLM` (`src/core.ts`): the stable DI token + the only API other plugins should depend on.
- `LLMHub` (`src/hub.ts`): default provider implementation (profiles + vault + routing + health).
- Optional adapters:
  - Ax: `pluxel-plugin-llm-hub/adapters/ax`
  - Ax → Vercel AI SDK v5: `pluxel-plugin-llm-hub/adapters/ax-ai-sdk-provider`
  - Vercel AI SDK options helper: `pluxel-plugin-llm-hub/aisdk`
- Optional utilities:
  - OpenAI-compatible model discovery (`GET /models`): `pluxel-plugin-llm-hub/models`
- UI + RPC (`src/ui/*`, `src/rpc.ts`): management surface only; not required for using `LLM.connection()`.

## Public surface (kept intentionally small)

 - `await llm.connection({ profileId? })` (SDK-agnostic, returns `{ profile, apiKey, fetch }`)
 - `await llm.connectionResult({ profileId? })` (Result-style)
 - Optional adapters:
   - Ax: `pluxel-plugin-llm-hub/adapters/ax`

Notes:
- `traceId/sessionId` is best-effort propagated into `fetch` as request headers (`x-pluxel-trace-id` / `x-pluxel-session-id`) for cross-cutting concerns (tracing, future usage accounting).
- Usage accounting/token stats are intentionally *not* baked into the surface yet; the hub currently tracks **availability health** only (for routing + circuit breaker). When we add usage later, prefer additive APIs (events/hooks) over wrapping every SDK call.

## Routing (deterministic selection)

When `profileId` is provided, `LLMHub` resolves that profile (and fails fast if it is disabled / missing key / circuit open).

When `profileId` is omitted:

- Candidate set: all `enabled: true` profiles.
- Sort order: higher `priority` first, then higher `updatedAt` first (stable tiebreak).
- Try candidates in order (fallback enabled by default):
  - If `allowFallback: false`, return the first failure.
  - Otherwise, fall back to the next candidate until one succeeds or all fail.

Per-call overrides:
- `allowFallback: false` disables fallback for this call only.
- `allowCircuitOpen: true` allows selecting a currently-open circuit (useful for “probe to recover”).

## Circuit breaker (availability semantics)

Scope: per-profile health in pluginData (`health` field), with config from:
- global settings (`settings.circuit`) as defaults
- per-profile overrides (`profile.circuit`) taking precedence per field

Failure signals (record a failure):
- HTTP: `401/403/429` and any `>= 500`
- Network exceptions from `fetch` (including `AbortError`)

Success signal:
- any `2xx` response resets `consecutiveFailures` to `0` and clears `openUntil`

Open circuit rule:
- after `failureThreshold` consecutive failures, set `openUntil = now + openMs`
- after cooldown (`openUntil <= now`), the next failure starts a *new* streak (so we don’t instantly re-open)

Gating points:
- Profile selection refuses open circuits by default.
- The returned `conn.fetch` also refuses requests when a circuit is open (so a stale connection can’t accidentally bypass routing).
- `allowCircuitOpen: true` bypasses both gates.

## Data model (storage + constraints)

Collections:
- `llm:profiles` (pluginData): profiles + routing metadata + health
- `llm:settings` (pluginData): global circuit defaults (single doc `id: "default"`)

Vault:
- API keys only (`llm:profiles:{id}:apiKey`), never persisted in pluginData.

Profile invariants (enforced on create/update):
- `provider`: required non-empty string (an identifier for adapters/UI, not interpreted by the hub)
- `model/baseURL/title`: optional strings (`undefined` means “not set”)
- `priority`: integer clamped to a safe range
- `config/options`: must be JSON objects (maps); never arrays

Security:
- `conn.apiKey` is considered sensitive and must not be logged or persisted.
- UI only displays `apiKeyPreview`, not the raw key.

## Provider naming (what `provider` means)

`provider` is intentionally a free-form identifier:
- The hub does not implement provider-specific behavior.
- Adapters may interpret it (e.g. Ax `ai({ name: provider })`).

Recommendation:
- prefer ecosystem/common names (`openai`, `anthropic`, `google`, `groq`, etc.)
- use `baseURL` for OpenAI-compatible proxies/self-hosted endpoints

### Adapter-level overrides (Ax example)

To avoid the hub turning into an SDK framework while still supporting *protocol-specific* APIs (e.g. OpenAI Responses),
adapters may read adapter-specific hints from `profile.options`:

- `options.axProvider` / `options.axProviderName`: override the Ax provider name (e.g. `openai-responses`)
- `options.ax`: an object with optional:
  - `providerName` / `provider`: same as `axProvider`
  - `purpose`: `default | loopback`
  - `config`: Ax model config overrides
  - `options`: Ax service options overrides

This keeps the hub surface stable while letting callers opt into richer upstream semantics when needed.

## Provider management UI

The default provider plugin `LLMHub` registers a simple host UI tab for managing profiles:
- create/edit profiles (including `priority`)
- set API key (stored in Vault)
- edit JSON `config`/`options` for advanced provider knobs
- circuit breaker defaults + per-profile overrides

### UI RPC API shape (recommended)

To avoid endless surface growth, the UI RPC is designed to converge on a single entry:

- `ctx.services.hmr.ui.LLMHub.request({ type: ... })`（RPC namespace = plugin id）

Current request types are profile-focused:
- `profiles:list | profiles:create | profiles:update | profiles:delete | profiles:resetHealth | profiles:setApiKey | profiles:clearApiKey`
- `settings:get | settings:update`

## Future: usage accounting (direction)

We intentionally avoid a “universal usage schema” inside the hub today.

The intended layering is:
- Hub-level: request timing/status and correlation (`traceId/sessionId`) via the instrumented `conn.fetch`.
- SDK-level: token usage from the SDK result object when available (AI SDK / Ax / others).

When we add usage later, prefer an additive API (events/hooks) so callers can opt in without changing callsites.
