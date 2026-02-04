# pluxel-plugin-bullmq

BullMQ service plugin with optional bull-board UI (Hono).

## What you get

- **Option helpers**: `baseOptions()` / `queueOptions()` resolve `connection/prefix/defaultJobOptions` from Pluxel config.
- **Safe-by-default tracking**: queues/workers/events/flows created via the plugin are auto-closed on plugin stop (and on caller unload), but you can opt out.
- **Connection visibility**: simple helpers for waiting on readiness and logging reconnects.
- **Optional UI**: bull-board mount via `ctx.honoService` (explicit call).

## Register

```ts
import { plugins as bullmqPlugins } from 'pluxel-plugin-bullmq'
```

## Use like BullMQ (raw + helpers)

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { BullMQPlugin } from 'pluxel-plugin-bullmq'
import { Queue, Worker, QueueEvents, FlowProducer } from 'bullmq'

@Plugin({ name: 'Jobs' })
export class Jobs extends BasePlugin {
  constructor(private bull: BullMQPlugin) {
    super()
  }

  async init() {
    const queue = new Queue('emails', this.bull.queueOptions())
    const worker = new Worker('emails', async (job) => {
      return { ok: true }
    }, this.bull.baseOptions({ concurrency: 5 }))

    const events = new QueueEvents('emails', this.bull.baseOptions())
    const flow = new FlowProducer(this.bull.baseOptions())

    // optional: monitor redis connection events
    this.bull.monitorConnection(queue, { label: 'emails' })
    await this.bull.ensureReady(queue)

    // remember to close resources when appropriate
    void Promise.allSettled([queue.close(), worker.close(), events.close(), flow.close()])
  }
}
```

## Use plugin-managed resources (auto cleanup)

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { BullMQPlugin } from 'pluxel-plugin-bullmq'

@Plugin({ name: 'Jobs' })
export class Jobs extends BasePlugin {
  constructor(private bull: BullMQPlugin) { super() }

  async init() {
    const queue = this.bull.queue('emails')
    const worker = this.bull.worker('emails', async (job) => ({ ok: true }))
    const events = this.bull.queueEvents(queue)
    const flow = this.bull.flowProducer()

    // resources above will auto-close on plugin stop/caller unload
  }
}
```

Opt out per resource with `false`:

```ts
const queue = this.bull.queue('emails', {}, false)
```

Or track external instances (and untrack when you take over lifecycle):

```ts
const queue = new Queue('emails', this.bull.queueOptions())
this.bull.track(queue)
this.bull.untrack(queue)
```

## Bull-board (optional)

Explicitly mount when needed:

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { BullMQPlugin } from 'pluxel-plugin-bullmq'

@Plugin({ name: 'Board' })
export class Board extends BasePlugin {
  constructor(private bull: BullMQPlugin) { super() }

  async init() {
    const emails = this.bull.queue('emails')
    this.bull.mountBullBoard({
      queues: [emails],
      basePath: '/queues',
      uiConfig: { boardTitle: 'Jobs' },
    })
  }
}
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
