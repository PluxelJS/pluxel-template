import { BasePlugin, type Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { HonoAdapter } from '@bull-board/hono'
import { serveStatic } from '@hono/node-server/serve-static'
import type { EffectGuard, Effects } from '@pluxel/core/services'
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

export type TrackOptions = {
	/** Default: true. Auto-dispose when caller plugin unloads. */
	trackToCaller?: boolean
	/**
	 * Default: true. Close resource when BullMQ plugin unloads.
	 *
	 * Notes:
	 * - Caller-bound cleanup always closes (that's usually the point of caller tracking).
	 * - This flag mainly controls provider-bound cleanup (i.e. BullMQ plugin unload).
	 */
	closeOnStop?: boolean
	/** Optional label for logs when auto-closing. */
	label?: string
	/**
	 * Optional explicit effects scope to bind caller-cleanup to.
	 *
	 * Useful in scripts/tests where there is no `ctx.caller`.
	 * Only used when `trackToCaller !== false`.
	 */
	effects?: Effects
}

export type BullBoardMountOptions = {
	/** Queues to expose in bull-board. */
	queues: Queue[]
	/** UI base path, e.g. `/queues` */
	basePath?: string
	/** UI config passed to bull-board (boardTitle, favIcon, etc.) */
	uiConfig?: Record<string, unknown>
	/** Custom serveStatic implementation for Hono (defaults to @hono/node-server). */
	serveStatic?: typeof serveStatic
}

export type BullBoardMountHandle = {
	/** bull-board API helpers (addQueue/removeQueue/etc). */
	api: ReturnType<typeof createBullBoard>
	/** Hono adapter instance. */
	adapter: HonoAdapter
	/** Mounted base path (normalized). */
	basePath: string
	/** Unmount handler from Hono (disposer). */
	dispose: () => void
}

export type BullMQClientTarget = {
	/** BullMQ connection promise (Queue/Worker/QueueEvents/FlowProducer all expose this). */
	client: Promise<RedisClient>
	/** Optional waitUntilReady (Queue/QueueEvents support this). */
	waitUntilReady?: () => Promise<RedisClient>
}

export type ConnectionMonitorOptions = {
	/** Label used in logs. */
	label?: string
	/** Default: true. Auto-dispose when caller plugin unloads. */
	trackToCaller?: boolean
	/** Optional explicit effects scope for scripts/tests (no caller). */
	effects?: Effects
}

type ManagedResource<T> = {
	resource: T
	closeOnStop: boolean
	label: string
	selfGuard: EffectGuard
	callerGuard: EffectGuard | null
}

@Plugin({ name: 'BullMQ', type: 'service' })
export class BullMQPlugin extends BasePlugin {
	private config: BullMQConfig = this.configs.use(BullMQConfigSchema)

	private queues = new Map<Queue, ManagedResource<Queue>>()
	private workers = new Map<Worker, ManagedResource<Worker>>()
	private events = new Map<QueueEvents, ManagedResource<QueueEvents>>()
	private flows = new Map<FlowProducer, ManagedResource<FlowProducer>>()

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
	 * Merge base defaults into any BullMQ options.
	 * - Uses `queue` (if provided) to inherit connection/prefix.
	 * - Falls back to plugin config when not provided.
	 */
	baseOptions<T extends { connection?: ConnectionOptions; prefix?: string }>(
		options: T = {} as T,
		queue?: Queue,
	): T & { connection: ConnectionOptions } {
		const { connection: _connection, prefix: _prefix, ...rest } = options as T
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
	queueOptions(options: QueueOptions = {}): QueueOptions {
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
	 * Pass `false` to skip tracking and manage lifecycle yourself.
	 */
	queue<DataType = any, ResultType = any, NameType extends string = string>(
		name: string,
		options: QueueOptions = {},
		track?: TrackOptions | false,
	): Queue<DataType, ResultType, NameType> {
		const queue = new Queue<DataType, ResultType, NameType>(name, this.queueOptions(options))
		return this.track(queue, track) as Queue<DataType, ResultType, NameType>
	}

	/**
	 * Create Worker with resolved options (tracked by default).
	 * `queue` may be a Queue instance to inherit connection/prefix.
	 */
	worker<DataType = any, ResultType = any, NameType extends string = string>(
		queue: string | Queue,
		processor: string | URL | null | Processor<DataType, ResultType, NameType>,
		options: WorkerOptions = {},
		track?: TrackOptions | false,
	): Worker<DataType, ResultType, NameType> {
		const name = typeof queue === 'string' ? queue : queue.name
		const opts = this.baseOptions(options, typeof queue === 'string' ? undefined : queue) as WorkerOptions
		const worker = new Worker<DataType, ResultType, NameType>(name, processor as any, opts)
		return this.track(worker, track) as Worker<DataType, ResultType, NameType>
	}

	/**
	 * Create QueueEvents with resolved options (tracked by default).
	 * Uses queue connection/prefix when a Queue is provided.
	 */
	queueEvents(queue: string | Queue, options: QueueEventsOptions = {}, track?: TrackOptions | false): QueueEvents {
		const name = typeof queue === 'string' ? queue : queue.name
		const opts = this.baseOptions(
			options,
			typeof queue === 'string' ? undefined : queue,
		) as QueueEventsOptions
		const events = new QueueEvents(name, opts)
		return this.track(events, track)
	}

	/**
	 * Create FlowProducer with resolved options (tracked by default).
	 */
	flowProducer(options: QueueBaseOptions = {}, track?: TrackOptions | false): FlowProducer {
		const flow = new FlowProducer(this.baseOptions(options) as QueueBaseOptions)
		return this.track(flow, track)
	}

	/**
	 * Track an external BullMQ resource for auto-cleanup.
	 * Pass `false` to skip tracking.
	 */
	track<T extends Queue | Worker | QueueEvents | FlowProducer>(
		resource: T,
		options?: TrackOptions | false,
	): T {
		if (resource instanceof Queue) {
			return this.trackManaged(this.queues, resource, options, `queue:${resource.name}`) as T
		}
		if (resource instanceof Worker) {
			return this.trackManaged(this.workers, resource, options, `worker:${resource.name}`) as T
		}
		if (resource instanceof QueueEvents) {
			return this.trackManaged(this.events, resource, options, `events:${resource.name}`) as T
		}
		if (resource instanceof FlowProducer) {
			return this.trackManaged(this.flows, resource, options, 'flow') as T
		}
		return resource
	}

	/** Stop tracking a resource (does not close it). */
	untrack(resource: Queue | Worker | QueueEvents | FlowProducer): boolean {
		const stop = <T extends Queue | Worker | QueueEvents | FlowProducer>(
			map: Map<T, ManagedResource<T>>,
			r: T,
		) => {
			const rec = map.get(r)
			if (!rec) return false
			map.delete(r)
			rec.selfGuard.cancel()
			rec.callerGuard?.cancel()
			return true
		}

		if (resource instanceof Queue) return stop(this.queues, resource)
		if (resource instanceof Worker) return stop(this.workers, resource)
		if (resource instanceof QueueEvents) return stop(this.events, resource)
		if (resource instanceof FlowProducer) return stop(this.flows, resource)
		return false
	}

	/**
	 * Await the underlying Redis connection with a consistent error message.
	 * Useful before critical operations that should fail fast.
	 */
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

			client.on('error', onError)
			client.on('close', onClose)
			client.on('end', onEnd)
			client.on('reconnecting', onReconnecting as any)
			client.on('ready', onReady)
		}

		const dispose = () => {
			if (disposed) return
			disposed = true
			if (!client) return
			client.off('error', onError)
			client.off('close', onClose)
			client.off('end', onEnd)
			client.off('reconnecting', onReconnecting as any)
			client.off('ready', onReady)
		}

		void attach()

		const trackToCaller = options.trackToCaller ?? true
		const ownerEffects: Effects | null =
			trackToCaller ? (options.effects ?? this.ctx.caller?.effects ?? null) : null

		let selfGuard!: EffectGuard
		let callerGuard: EffectGuard | null = null

		const disposeFromCaller = () => {
			dispose()
			// Provider may outlive caller; cancel provider cleanup to avoid duplicate work.
			selfGuard.cancel()
		}

		const disposeFromSelf = () => {
			dispose()
			// Provider is going away; detach from caller effects to avoid cross-plugin retention.
			callerGuard?.cancel()
		}

		selfGuard = this.ctx.effects.defer(disposeFromSelf, { tag: `bullmq:monitor:self:${label}` })
		if (ownerEffects) callerGuard = ownerEffects.defer(disposeFromCaller, { tag: `bullmq:monitor:caller:${label}` })

		return () => {
			dispose()
			selfGuard.cancel()
			callerGuard?.cancel()
		}
	}

	/**
	 * Mount bull-board UI routes via HonoService (explicit call only).
	 * Returns a handle with disposer for unmounting.
	 */
	mountBullBoard(options: BullBoardMountOptions): BullBoardMountHandle {
		const basePath = normalizeBasePath(options.basePath ?? '/bullmq')
		const adapter = new HonoAdapter(options.serveStatic ?? serveStatic)
		const api = createBullBoard({
			queues: options.queues.map((queue) => new BullMQAdapter(queue)),
			serverAdapter: adapter,
			options: { uiConfig: options.uiConfig ?? {} },
		})

		adapter.setBasePath(basePath)
		const dispose = this.ctx.honoService.modifyApp((app: any) => {
			app.route(basePath, adapter.registerPlugin())
		})

		return { api, adapter, basePath, dispose }
	}

	private mergeDefaultJobOptions(next?: JobsOptions): JobsOptions | undefined {
		const base = this.config.defaultJobOptions ?? {}
		const merged = { ...base, ...(next ?? {}) }
		return Object.keys(merged).length ? (merged as JobsOptions) : undefined
	}

	private trackManaged<T extends { close: () => Promise<void> }>(
		map: Map<T, ManagedResource<T>>,
		resource: T,
		track: TrackOptions | false | undefined,
		fallbackLabel: string,
	): T {
		if (map.has(resource)) return resource
		if (track === false) return resource

		const label = track?.label?.trim() || fallbackLabel
		const closeOnStop = track?.closeOnStop ?? true
		const trackToCaller = track?.trackToCaller ?? true
		const ownerEffects: Effects | null =
			trackToCaller ? (track?.effects ?? this.ctx.caller?.effects ?? null) : null

		const record: ManagedResource<T> = {
			resource,
			closeOnStop,
			label,
			selfGuard: undefined as any,
			callerGuard: null,
		}
		map.set(resource, record)

		const close = () =>
			record.resource.close().catch((error) => {
				this.ctx.logger.debug('close failed ({label})', { label, error })
			})

		const cleanupFromCaller = () => {
			if (!map.delete(resource)) return
			// Caller tracking implies "owned by caller": always close on caller unload.
			void close()
			// Provider may outlive the caller; cancel provider cleanup to avoid duplicate work.
			record.selfGuard.cancel()
		}

		const cleanupFromSelf = () => {
			if (!map.delete(resource)) return
			if (record.closeOnStop) void close()
			// Provider is going away; detach from caller effects to avoid cross-plugin retention.
			record.callerGuard?.cancel()
		}

		record.selfGuard = this.ctx.effects.defer(cleanupFromSelf, { tag: `bullmq:track:self:${label}` })
		if (ownerEffects) record.callerGuard = ownerEffects.defer(cleanupFromCaller, { tag: `bullmq:track:caller:${label}` })
		return resource
	}
}

// biome-ignore lint/style/noDefaultExport: keep compatibility with existing default import users
export default BullMQPlugin

function normalizeBasePath(input: string): string {
	const raw = String(input ?? '').trim()
	if (!raw || raw === '/') return '/bullmq'
	const withSlash = raw.startsWith('/') ? raw : `/${raw}`
	return withSlash.replace(/\/+$/, '')
}
