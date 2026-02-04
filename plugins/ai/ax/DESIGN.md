# Ax Plugin (Design Notes)

Goal: expose a *small* and *composable* LLM service for the Pluxel/HMR plugin runtime.

## Core ideas

- **Single runtime token**: other plugins depend on `Ax` and do not care about the backing provider.
- **Profiles are data**, not code:
  - provider/model/apiURL/options/config stored in pluginData (`signaldb` collection).
  - API keys stored in Vault (never in pluginData).
- **Tools are owned by the caller plugin**:
  - `ax.tool(fn)` registers a raw Ax function (name conflict checked).
  - hot reload safety: when a plugin reloads (new Context instance), old tools for that plugin are dropped.
- **cmdkit bridge is data-only**:
  - `ax.cmd(exec)` turns a cmdkit `exec.mcp` executable into an Ax function tool.
  - cmdkit `ExecCtx.meta` is best-effort populated from Ax function `extra` (trace/session).

## Public surface (kept intentionally small)

- `await ax.ai({ profileId? })`
- `ax.tool(fn)`
- `ax.cmd(exec)` / `ax.cmdExports(mod)` / `ax.cmdCatalog(catalog)`
- `await ax.tooling({ profileId?, functions? })` (returns `{ ai, functions }`)
- Decorators: `WithAxAI()` / `WithAxTooling()` (optional, like `kv`'s decorators)

## Provider management UI

The default provider plugin `AxHub` registers a simple host UI tab for managing profiles:
- create/set default profiles
- set API key (stored in Vault)
- edit JSON `config`/`options` for advanced provider knobs

### UI RPC API shape (recommended)

To avoid endless surface growth, the UI RPC is designed to converge on a single entry:

- `ctx.services.hmr.ui.Ax.request({ type: ... })`

Current request types are profile-focused:
- `profiles:list | profiles:create | profiles:update | profiles:setDefault | profiles:delete | profiles:setApiKey | profiles:clearApiKey`

Legacy methods like `profiles()` / `createProfile()` are kept as deprecated wrappers for compatibility.
