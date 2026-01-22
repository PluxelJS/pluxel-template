# pluxel-plugin-cmd-catalog

Tiny catalog/registry helpers for `@pluxel/cmd` executables:

- discover executables from module exports
- compose a text router (`createRouter`) from registered text commands
- expose MCP tool descriptors (data-only)
- generate **permission node strings / declaration lists** (data-only)

## Why this exists

`@pluxel/cmd` is deliberately **host-neutral**. This package provides the optional “composition layer”
so plugins can stay dependency-light while hosts can discover and combine commands/tools.

## Permission strings (data-only)

This package can generate permission nodes using a bot-suite-compatible convention:

- exact: `cmd.<localId>`
- star: `cmd.*` and `cmd.<group>.*` (group is derived from `localId` prefix before the first dot)

These are **only declarations** (strings + defaults). They do not depend on user/roles.
Enforcement belongs to the host (e.g. bot-suite `PermissionService`), typically via an interceptor.
