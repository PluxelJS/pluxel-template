# pluxel-plugin-bullmq

BullMQ service plugin with optional bull-board UI (Hono).

## What you get

- **Option helpers**: `baseOptions()` / `queueOptions()` resolve `connection/prefix/defaultJobOptions` from Pluxel config.
- **Safe-by-default lifecycle**: resources created via the plugin are auto-closed on plugin stop (and, by default, on caller unload).
- **Efficient defaults**: `queue()` / `queueEvents()` / `flowProducer()` reuse instances within the same caller/plugin scope (avoid accidental duplicates).
- **Connection visibility**: `ensureReady()` + `monitorConnection()` helpers for readiness/reconnect logs.
- **Optional UI (feature)**: bull-board is exposed as `bull.bullboard` (`this.features.use(...)`) and can be mounted explicitly.

## Register

```ts
import { plugins as bullmqPlugins } from 'pluxel-plugin-bullmq'
```

## Typical usage (plugin-managed resources)

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { BullMQPlugin } from 'pluxel-plugin-bullmq'

@Plugin({ name: 'Jobs' })
export class Jobs extends BasePlugin {
  constructor(private bull: BullMQPlugin) {
    super()
  }

  async init() {
    const queue = this.bull.queue('emails')
    this.bull.worker(queue, async (job) => ({ ok: true }))

    // optional: connection diagnostics
    this.bull.monitorConnection(queue, { label: 'emails' })
    await this.bull.ensureReady(queue)
  }
}
```

## Raw BullMQ (bring your own lifecycle)

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { BullMQPlugin } from 'pluxel-plugin-bullmq'
import { Queue, Worker } from 'bullmq'

@Plugin({ name: 'Jobs' })
export class Jobs extends BasePlugin {
  constructor(private bull: BullMQPlugin) { super() }

  async init() {
    const queue = new Queue('emails', this.bull.queueOptions())
    const worker = new Worker('emails', async (job) => ({ ok: true }), this.bull.baseOptions({ concurrency: 5 }))

    // you own lifecycle when you construct BullMQ classes directly
    void Promise.allSettled([worker.close(), queue.close()])
  }
}
```

## Tracking / lifecycle notes

- Default: resources created via `bull.queue/worker/queueEvents/flowProducer` are tracked.
- If you need custom lifecycle: either construct BullMQ classes directly (raw mode), or call `this.bull.untrack(resource)` after creation.
- Track external instances: `this.bull.track(queue, { owner: 'caller' })` (or `{ owner: 'plugin' }`).
- `untrack()` stops tracking and does **not** close the resource.

## Bull-board (optional)

Recommended: use the feature entrypoint:

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { BullMQPlugin } from 'pluxel-plugin-bullmq'

@Plugin({ name: 'Board' })
export class Board extends BasePlugin {
  constructor(private bull: BullMQPlugin) { super() }

  async init() {
    const emails = this.bull.queue('emails')
    this.bull.bullboard.mount({
      queues: [emails],
      basePath: '/queues',
      uiConfig: { boardTitle: 'Jobs' },
    })
  }
}
```

Convenience: mount all currently tracked queues:

```ts
this.bull.mountBullBoardTracked({ basePath: '/queues' })
```

If you need advanced bull-board wiring (custom adapters, auth, multi-app routing), use `@bull-board/api` directly.

## Config

```ts
import { BullMQConfigSchema } from 'pluxel-plugin-bullmq'
```

- `url`: Redis URL (alternative to `connection`).
- `connection`: BullMQ connection options (ioredis options or cluster options).
- `prefix`: Optional key prefix for all queues.
- `defaultJobOptions`: Merged into every queue's `defaultJobOptions`.

Bull-board feature config (optional):

- `bullboard.config.basePath`
- `bullboard.config.uiConfig`
