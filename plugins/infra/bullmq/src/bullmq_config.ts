import type { Config } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'

export const BullMQConfigSchema = v.object({
	/** Redis URL, e.g. redis://localhost:6379/0 */
	url: v.optional(v.string()),
	/** BullMQ connection options (ioredis options or cluster options). */
	connection: v.optional(v.record(v.string(), v.any())),
	/** Optional key prefix for all queues. */
	prefix: v.optional(v.string()),
	/** Default job options merged into every queue's `defaultJobOptions`. */
	defaultJobOptions: v.optional(v.record(v.string(), v.any()), {}),
})

export type BullMQConfig = Config<typeof BullMQConfigSchema>

