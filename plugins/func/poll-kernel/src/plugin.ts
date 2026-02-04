import { type Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { MikroOrm } from 'pluxel-plugin-mikro-orm'
import { PollKernel } from './core.js'
import { PollKernelEngine } from './kernel.js'
import { MikroRepo } from './repo.js'

// Ensure emitDecoratorMetadata captures runtime classes for DI.
void MikroOrm
export const PollKernelConfigSchema = v.object({
	scopeKey: v.optional(v.string()),
	ensureSchema: v.optional(v.boolean(), true),
	dropTableOnDispose: v.optional(v.boolean(), false),
	specCacheSize: v.optional(v.number(), 1024),
	enableInProcessQueue: v.optional(v.boolean(), true),
	snapshotCacheSize: v.optional(v.number(), 2048),
	queueCacheSize: v.optional(v.number(), 4096),
})

export type PollKernelConfig = Config<typeof PollKernelConfigSchema>

@Plugin(PollKernel, { name: 'PollKernel', type: 'service' })
export class PollKernelMikro extends PollKernel {
	private readonly config: PollKernelConfig = this.configs.use(PollKernelConfigSchema)

	constructor(private readonly mikro: MikroOrm) {
		super()
	}

	protected createDriver(): PollKernelEngine {
		const cfg = this.config
		const scopeKey = cfg.scopeKey && cfg.scopeKey.trim() ? cfg.scopeKey : this.ctx.pluginInfo.id
		const repo = new MikroRepo(this.mikro, {
			scopeKey,
			ensureSchema: cfg.ensureSchema,
			dropTableOnDispose: cfg.dropTableOnDispose,
			specCacheSize: Math.max(1, Math.floor(cfg.specCacheSize)),
		})
		return new PollKernelEngine(repo, {
			enableInProcessQueue: cfg.enableInProcessQueue,
			snapshotCacheSize: Math.max(0, Math.floor(cfg.snapshotCacheSize)),
			queueCacheSize: Math.max(1, Math.floor(cfg.queueCacheSize)),
		})
	}
}
