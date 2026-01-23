# pluxel-plugin-ax

Ax LLM service plugin for the Pluxel/HMR runtime.

Design:
- Provider profiles are data-driven (pluginData) and API keys live in Vault.
- Other plugins can register reusable Ax tools, and can bridge cmdkit MCP tools (`exec.mcp`) into Ax functions.
- UI is optional but included for managing profiles (no hard-coded `@Config` provider settings).

## Quick usage

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { cmd } from '@pluxel/cmd'
import { Ax } from 'pluxel-plugin-ax'
import { ax } from 'pluxel-plugin-ax/sdk'

@Plugin({ name: 'MyPlugin' })
export class MyPlugin extends BasePlugin {
	constructor(private readonly axSvc: Ax) {
		super()
	}

	override async init() {
		// Ensure Ax has a default profile in its UI first.

		const echo = cmd('echo')
			.input({ '~standard': { version: 1, vendor: 'demo', types: { input: {} as any, output: {} as any }, validate: (v: unknown) => ({ value: v }) } } as any)
			.mcp({ title: 'Echo', description: 'Echo a message' })
			.handle((i: any) => i)
			.build()

		this.axSvc.cmd(echo)

		const { ai, functions } = await this.axSvc.tooling()
		const gen = ax('msg:string -> out:string', { functions })
		const out = await gen.forward(ai, { msg: 'hi' })
		this.ctx.logger.info('ax out', out as any)
	}
}
```

## Decorators

Decorator helpers that inject `AxAI` / `{ ai, functions }` as the first argument.

Note: your plugin still needs to declare `Ax` as a dependency (constructor param or `setParamToken`) because `pluginMethodDecorator(...)` requires it.

```ts
import type { AxAI } from '@ax-llm/ax'
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { Ax } from 'pluxel-plugin-ax'
import { WithAxAI } from 'pluxel-plugin-ax/decorators'

@Plugin({ name: 'MyPlugin' })
export class MyPlugin extends BasePlugin {
	constructor(_ax: Ax) {
		super()
	}

	@WithAxAI()
	async summarize(ai: AxAI, text: string) {
		// ...
	}
}
```

## Streaming (AsyncGenerator)

Best when you want **incremental UX** (CLI output, UI live-updates, early cancel):

```ts
import { ax } from '@ax-llm/ax'

const { ai, functions } = await axSvc.tooling()
const gen = ax('msg:string -> out:string', { functions })

for await (const chunk of gen.streamingForward(ai, { msg: 'hello' })) {
	if (chunk.delta.out) process.stdout.write(chunk.delta.out)
}
```
