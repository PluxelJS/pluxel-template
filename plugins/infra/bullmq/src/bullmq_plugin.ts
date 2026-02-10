import { BasePlugin, Plugin } from '@pluxel/hmr'
import type { Effects } from '@pluxel/core/services'
import type { EventEmitter } from 'node:events'
import {
	FlowProducer,
	Queue,
	QueueEvents,
	Worker,
	type ConnectionOptions,
	type JobsOptions,
	type Processor,
	type QueueBaseOptions,
	type QueueEventsOptions,
	type QueueOptions,
	type RedisClient,
	type WorkerOptions,
} from 'bullmq'
import { BullBoardFeature, type BullBoardMountHandle, type BullBoardMountOptions } from './bullboard_feature'
import { BullMQConfigSchema, type BullMQConfig } from './bullmq_config'
import type {
	BullMQBaseOptionsInput,
	BullMQClientTarget,
	BullMQQueueEventsOptionsInput,
	BullMQQueueOptionsInput,
	BullMQWorkerOptionsInput,
	Closeable,
	TrackOptions,
} from './bullmq_types'
import { trackResource, untrackResource, type ManagedResource } from './resource_tracking'

type AnyQueue = Queue<any, any, any, any, any, any>

export type ConnectionMonitorOptions = {
	/** Label used in logs. */
	label?: string
	/** Optional explicit effects scope (defaults to caller effects when available). */
	effects?: Effects
}

@Plugin({ name: 'BullMQ', type: 'service' })
export class BullMQPlugin extends BasePlugin {
	private readonly config: BullMQConfig = this.configs.use(BullMQConfigSchema)

	readonly bullboard = this.features.use(BullBoardFeature)

	private readonly tracked = new Map<Closeable, ManagedResource>()

	private readonly queueByOwner = new WeakMap<Effects, Map<string, AnyQueue>>()
	private readonly eventsByOwner = new WeakMap<Effects, Map<string, QueueEvents>>()
	private readonly flowByOwner = new WeakMap<Effects, FlowProducer>()

	/**
	 * Resolve BullMQ connection options from explicit args or plugin config.
	 * Throws if neither `connection` nor `url` is configured.
	 */
	connectionOptions(explicit?: ConnectionOptions): ConnectionOptions {
		if (explicit) return explicit
		if (this.config.connection) return this.config.connection as ConnectionOptions
		if (this.config.url) return { url: this.config.url } as ConnectionOptions
		throw new Error('[BullMQ] missing config: connection or url')
	}

	/**
	 * Merge base defaults into BullMQ options.
	 * - Uses `queue` (if provided) to inherit connection/prefix.
	 * - Falls back to plugin config when not provided.
	 */
	baseOptions<T extends { connection?: ConnectionOptions; prefix?: string }>(
		options: T = {} as T,
		queue?: AnyQueue,
	): T & { connection: ConnectionOptions } {
		const { connection: _connection, prefix: _prefix, ...rest } = options
		const connection = _connection ?? queue?.opts?.connection ?? this.connectionOptions()
		const prefix = _prefix ?? queue?.opts?.prefix ?? this.config.prefix

		return {
			...rest,
			...(prefix !== undefined ? { prefix } : {}),
			connection,
		} as T & { connection: ConnectionOptions }
	}

	/**
	 * Merge defaults into QueueOptions.
	 * Includes `defaultJobOptions` from plugin config.
	 */
	queueOptions(options: BullMQQueueOptionsInput = {}): QueueOptions {
		const { defaultJobOptions: _jobs, ...rest } = options
		const base = this.baseOptions(rest)
		const defaultJobOptions = this.mergeDefaultJobOptions(_jobs)

		return {
			...base,
			...(defaultJobOptions ? { defaultJobOptions } : {}),
		}
	}

	/**
	 * Create Queue with resolved options (tracked by default).
	 * Reuses an existing instance within the same caller/plugin scope.
	 */
	queue<DataType = any, ResultType = any, NameType extends string = string>(
		name: string,
		options: BullMQQueueOptionsInput = {},
	): Queue<DataType, ResultType, NameType> {
		const owner = this.ownerEffects()
		const cache = this.cacheFor(this.queueByOwner, owner)
		const existing = cache.get(name)
		if (existing) return existing as unknown as Queue<DataType, ResultType, NameType>

		const queue = new Queue<DataType, ResultType, NameType>(name, this.queueOptions(options))
		this.track(queue, { label: `queue:${name}` })
		cache.set(name, queue as unknown as AnyQueue)
		return queue
	}

	/**
	 * Create Worker with resolved options (tracked by default).
	 * `queue` may be a Queue instance to inherit connection/prefix.
	 */
	worker<DataType = any, ResultType = any, NameType extends string = string>(
		queue: string | AnyQueue,
		processor: string | URL | null | Processor<DataType, ResultType, NameType>,
		options: BullMQWorkerOptionsInput = {},
	): Worker<DataType, ResultType, NameType> {
		const name = typeof queue === 'string' ? queue : queue.name
		const opts = this.baseOptions(options, typeof queue === 'string' ? undefined : queue) as WorkerOptions
		const worker = new Worker<DataType, ResultType, NameType>(name, processor, opts)
		this.track(worker, { label: `worker:${name}` })
		return worker
	}

	/**
	 * Create QueueEvents with resolved options (tracked by default).
	 * Uses queue connection/prefix when a Queue is provided.
	 */
	queueEvents(
		queue: string | AnyQueue,
		options: BullMQQueueEventsOptionsInput = {},
	): QueueEvents {
		const name = typeof queue === 'string' ? queue : queue.name
		const owner = this.ownerEffects()
		const cache = this.cacheFor(this.eventsByOwner, owner)
		const existing = cache.get(name)
		if (existing) return existing

		const opts = this.baseOptions(
			options,
			typeof queue === 'string' ? undefined : queue,
		) as QueueEventsOptions
		const events = new QueueEvents(name, opts)
		this.track(events, { label: `events:${name}` })
		cache.set(name, events)
		return events
	}

	/** Create FlowProducer with resolved options (tracked by default, cached per owner scope). */
	flowProducer(options: BullMQBaseOptionsInput = {}): FlowProducer {
		const owner = this.ownerEffects()
		const existing = this.flowByOwner.get(owner)
		if (existing) return existing

		const flow = new FlowProducer(this.baseOptions(options) as QueueBaseOptions)
		this.track(flow, { label: 'flow' })
		this.flowByOwner.set(owner, flow)
		return flow
	}

	/** Track an external closeable resource for auto-cleanup. Pass `false` to skip tracking. */
	track<T extends Closeable>(resource: T, options?: TrackOptions | false): T {
		const ctor = (resource as unknown as { constructor?: unknown }).constructor
		const name = typeof ctor === 'function' ? ctor.name : ''
		const fallbackLabel = name ? `resource:${name}` : 'resource'
		return trackResource(this.ctx, this.tracked, resource, options, fallbackLabel)
	}

	/** Stop tracking a resource (does not close it). */
	untrack(resource: Closeable): boolean {
		return untrackResource(this.tracked, resource)
	}

	/** Tracked queues created via `this.queue(...)` (and any external queues you `track(...)`). */
	trackedQueues(): AnyQueue[] {
		const out: AnyQueue[] = []
		for (const resource of this.tracked.keys()) {
			if (resource instanceof Queue) out.push(resource as unknown as AnyQueue)
		}
		return out
	}

	/** Convenience: mount bull-board for all currently tracked queues. */
	mountBullBoardTracked(options?: Omit<BullBoardMountOptions, 'queues'>): BullBoardMountHandle {
		return this.bullboard.mount({ queues: this.trackedQueues(), ...(options ?? {}) })
	}

	/** Back-compat mount entry (delegates to feature). */
	mountBullBoard(options: BullBoardMountOptions): BullBoardMountHandle {
		return this.bullboard.mount(options)
	}

	/** Await the underlying Redis connection with a consistent error message. */
	async ensureReady(target: BullMQClientTarget): Promise<RedisClient> {
		try {
			if (typeof target.waitUntilReady === 'function') return await target.waitUntilReady()
			return await target.client
		} catch (error) {
			this.ctx.logger.error('bullmq connection not ready', { error })
			throw error
		}
	}

	/**
	 * Attach basic connection logs to help diagnose disconnects/reconnects.
	 * Returns a disposer that removes listeners.
	 */
	monitorConnection(target: BullMQClientTarget, options: ConnectionMonitorOptions = {}): () => void {
		const label = options.label?.trim() || 'bullmq'
		let disposed = false
		let client: RedisClient | undefined
		let emitter: EventEmitter | undefined

		const onError = (error: unknown) => this.ctx.logger.warn('redis error ({label})', { label, error })
		const onClose = () => this.ctx.logger.warn('redis closed ({label})', { label })
		const onEnd = () => this.ctx.logger.warn('redis ended ({label})', { label })
		const onReconnecting = (delay: number) =>
			this.ctx.logger.info('redis reconnecting ({label})', { label, delay })
		const onReady = () => this.ctx.logger.info('redis ready ({label})', { label })

		const attach = async () => {
			try {
				client = await target.client
			} catch (error) {
				if (!disposed) this.ctx.logger.warn('redis client unavailable ({label})', { label, error })
				return
			}
			if (disposed || !client) return

			emitter = client as unknown as EventEmitter
			emitter.on('error', onError as any)
			emitter.on('close', onClose as any)
			emitter.on('end', onEnd as any)
			emitter.on('reconnecting', onReconnecting as any)
			emitter.on('ready', onReady as any)
		}

		const detach = () => {
			if (!emitter) return
			const off =
				typeof emitter.off === 'function'
					? emitter.off.bind(emitter)
					: emitter.removeListener.bind(emitter)
			off('error', onError as any)
			off('close', onClose as any)
			off('end', onEnd as any)
			off('reconnecting', onReconnecting as any)
			off('ready', onReady as any)
		}

		const dispose = () => {
			if (disposed) return
			disposed = true
			detach()
		}

		void attach()

		const ownerEffects: Effects | null = options.effects ?? this.ctx.caller?.effects ?? null

		let selfGuard = this.ctx.effects.defer(() => {
			dispose()
		}, { tag: `bullmq:monitor:self:${label}` })

		const ownerGuard = ownerEffects
			? ownerEffects.defer(() => {
					dispose()
					selfGuard.cancel()
				}, { tag: `bullmq:monitor:owner:${label}` })
			: null

		return () => {
			dispose()
			selfGuard.cancel()
			ownerGuard?.cancel()
		}
	}

	private ownerEffects(): Effects {
		return (this.ctx.caller?.effects ?? this.ctx.effects) as Effects
	}

	private cacheFor<T>(store: WeakMap<Effects, Map<string, T>>, owner: Effects): Map<string, T> {
		const existing = store.get(owner)
		if (existing) return existing
		const created = new Map<string, T>()
		store.set(owner, created)
		return created
	}

	private mergeDefaultJobOptions(next?: JobsOptions): JobsOptions | undefined {
		const base = this.config.defaultJobOptions ?? {}
		const merged = { ...base, ...(next ?? {}) }
		return Object.keys(merged).length ? (merged as JobsOptions) : undefined
	}
}

// biome-ignore lint/style/noDefaultExport: keep compatibility with existing default import users
export default BullMQPlugin
