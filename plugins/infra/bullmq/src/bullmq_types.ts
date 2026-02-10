import type { Effects } from '@pluxel/core/services'
import type {
	ConnectionOptions,
	QueueBaseOptions,
	QueueEventsOptions,
	QueueOptions,
	RedisClient,
	WorkerOptions,
} from 'bullmq'

export type BullMQBaseOptionsInput = Omit<QueueBaseOptions, 'connection'> & { connection?: ConnectionOptions }
export type BullMQQueueOptionsInput = Omit<QueueOptions, 'connection'> & { connection?: ConnectionOptions }
export type BullMQWorkerOptionsInput = Omit<WorkerOptions, 'connection'> & { connection?: ConnectionOptions }
export type BullMQQueueEventsOptionsInput = Omit<QueueEventsOptions, 'connection'> & { connection?: ConnectionOptions }

export type TrackOwner = 'caller' | 'plugin' | 'custom'

export type TrackOptions = {
	/** Optional label for logs / effect tags. */
	label?: string
	/** Default: true. Close the resource when the owning scope is disposed. */
	closeOnStop?: boolean

	/**
	 * Which scope owns the resource.
	 *
	 * - `caller` (default when there is a caller): close when caller plugin unloads
	 * - `plugin` (default when there is no caller): close when BullMQ plugin stops
	 * - `custom`: close when `effects` is disposed
	 */
	owner?: TrackOwner

	/**
	 * Custom effects scope used when `owner: "custom"`.
	 */
	effects?: Effects
}

export type Closeable = { close: (...args: any[]) => Promise<void> }

export type BullMQClientTarget = {
	/** BullMQ connection promise (Queue/Worker/QueueEvents/FlowProducer all expose this). */
	client: Promise<RedisClient>
	/** Optional waitUntilReady (Queue/QueueEvents/Worker/FlowProducer support this). */
	waitUntilReady?: () => Promise<RedisClient>
}
