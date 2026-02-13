import type { OtlpSignal, OtlpSignalStats } from './core.js'
import type { OtlpHubBatchConfig, OtlpHubQueueConfig } from './config.js'
import type { OtlpHttpJsonItem } from './encode.js'

type OverflowMode = 'dropNewest' | 'dropOldest' | 'block'

export class OtlpHttpJsonQueue {
	private readonly signal: OtlpSignal
	private readonly enabled: boolean
	private readonly batch: OtlpHubBatchConfig
	private readonly queueCfg: OtlpHubQueueConfig
	private readonly timeoutMs: number
	private readonly buildBody: (items: readonly OtlpHttpJsonItem[]) => string
	private readonly sendRequest: (body: string, timeoutMs: number) => Promise<void>
	private readonly warn: (message: string, meta: Record<string, unknown>) => void

	private flushTimeout: any = null
	private flushRunning = false
	private flushPending = false

	private inflight = 0
	private sentBatches = 0
	private sentItems = 0
	private dropped = 0
	private droppedQueueFull = 0
	private droppedDisabled = 0
	private lastError: OtlpSignalStats['lastError'] | undefined
	private consecutiveSendFailures = 0
	private backoffUntilMs = 0
	private lastFlushWarnAtMs = 0

	private queued: OtlpHttpJsonItem[] = []
	private head = 0
	private queuedBytes = 0
	private waiting: Array<() => void> = []
	private idleWaiters: Array<() => void> = []

	constructor(opts: {
		signal: OtlpSignal
		enabled: boolean
		batch: OtlpHubBatchConfig
		queueCfg: OtlpHubQueueConfig
		timeoutMs: number
		buildBody: (items: readonly OtlpHttpJsonItem[]) => string
		sendRequest: (body: string, timeoutMs: number) => Promise<void>
		warn: (message: string, meta: Record<string, unknown>) => void
	}) {
		this.signal = opts.signal
		this.enabled = opts.enabled
		this.batch = opts.batch
		this.queueCfg = opts.queueCfg
		this.timeoutMs = opts.timeoutMs
		this.buildBody = opts.buildBody
		this.sendRequest = opts.sendRequest
		this.warn = opts.warn
	}

	stats(): OtlpSignalStats {
		return {
			enabled: this.enabled,
			queued: this.queuedCount(),
			queuedBytes: this.queuedBytes,
			inflight: this.inflight,
			sentBatches: this.sentBatches,
			sentItems: this.sentItems,
			dropped: this.dropped,
			droppedQueueFull: this.droppedQueueFull,
			droppedDisabled: this.droppedDisabled,
			...(this.lastError ? { lastError: this.lastError } : {}),
		}
	}

	clearTimers(): void {
		if (!this.flushTimeout) return
		try {
			clearTimeout(this.flushTimeout)
		} finally {
			this.flushTimeout = null
		}
	}

	private notifyIdle(): void {
		if (this.inflight !== 0) return
		if (this.idleWaiters.length === 0) return
		const toRelease = this.idleWaiters.slice()
		this.idleWaiters.length = 0
		for (const r of toRelease) r()
	}

	private waitForIdle(): Promise<void> {
		if (this.inflight === 0) return Promise.resolve()
		return new Promise((resolve) => this.idleWaiters.push(resolve))
	}

	private releaseWaiters(): void {
		if (this.waiting.length === 0) return
		const toRelease = this.waiting.slice()
		this.waiting.length = 0
		for (const r of toRelease) r()
	}

	private shouldFlushNow(): boolean {
		const maxBatchRecords = Math.max(1, Math.floor(this.batch.maxBatchRecords))
		const maxBatchBytes = Math.max(1, Math.floor(this.batch.maxBatchBytes))
		return this.queuedCount() >= maxBatchRecords || this.queuedBytes >= maxBatchBytes
	}

	private scheduleFlush(): void {
		if (!this.enabled) return
		if (this.flushTimeout) return
		const now = Date.now()
		const baseDelay = Math.max(0, Math.floor(this.batch.flushIntervalMs))
		const backoffDelay = Math.max(0, this.backoffUntilMs - now)
		const delay = Math.max(baseDelay, backoffDelay)
		this.flushTimeout = setTimeout(() => {
			this.flushTimeout = null
			this.kickFlush()
		}, delay)
	}

	private afterEnqueue(): void {
		if (!this.enabled) return
		if (this.shouldFlushNow()) {
			this.kickFlush()
			return
		}
		this.scheduleFlush()
	}

	private takeBatch(): OtlpHttpJsonItem[] {
		const maxBatchRecords = Math.max(1, Math.floor(this.batch.maxBatchRecords))
		const maxBatchBytes = Math.max(1, Math.floor(this.batch.maxBatchBytes))

		const batch: OtlpHttpJsonItem[] = []
		let bytes = 0
		while (batch.length < maxBatchRecords && this.queuedCount() > 0) {
			const next = this.queued[this.head]!
			if (batch.length > 0 && bytes + next.bytes > maxBatchBytes) break
			this.head++
			this.queuedBytes -= next.bytes
			batch.push(next)
			bytes += next.bytes
		}
		this.maybeCompact()
		return batch
	}

	private queuedCount(): number {
		return Math.max(0, this.queued.length - this.head)
	}

	private maybeCompact(): void {
		if (this.head === 0) return
		if (this.head < 1024 && this.head < this.queued.length / 2) return
		this.queued = this.queued.slice(this.head)
		this.head = 0
	}

	private dropOldestOne(): void {
		if (this.queuedCount() === 0) return
		const removed = this.queued[this.head]!
		this.head++
		this.queuedBytes -= removed.bytes
		this.dropped++
		this.droppedQueueFull++
		this.maybeCompact()
	}

	private tryEnqueueInner(item: OtlpHttpJsonItem, opts: { allowBlock: boolean }): { ok: boolean; shouldBlock: boolean } {
		if (!this.enabled) {
			this.dropped++
			this.droppedDisabled++
			return { ok: false, shouldBlock: false }
		}

		const maxItems = Math.max(1, Math.floor(this.queueCfg.maxQueuedRecords))
		const maxBytes = Math.max(1, Math.floor(this.queueCfg.maxQueuedBytes))
		const overflow = this.queueCfg.overflow as OverflowMode

		const fits = () => this.queuedCount() < maxItems && this.queuedBytes + item.bytes <= maxBytes

		if (fits()) {
			this.queued.push(item)
			this.queuedBytes += item.bytes
			this.afterEnqueue()
			return { ok: true, shouldBlock: false }
		}

		if (overflow === 'dropOldest') {
			while (this.queuedCount() > 0 && !fits()) this.dropOldestOne()
			if (!fits()) {
				this.dropped++
				this.droppedQueueFull++
				return { ok: false, shouldBlock: false }
			}
			this.queued.push(item)
			this.queuedBytes += item.bytes
			this.afterEnqueue()
			return { ok: true, shouldBlock: false }
		}

		if (overflow === 'block') {
			if (opts.allowBlock) return { ok: false, shouldBlock: true }
			this.dropped++
			this.droppedQueueFull++
			return { ok: false, shouldBlock: false }
		}

		this.dropped++
		this.droppedQueueFull++
		return { ok: false, shouldBlock: false }
	}

	tryEnqueue(item: OtlpHttpJsonItem): boolean {
		return this.tryEnqueueInner(item, { allowBlock: false }).ok
	}

	async enqueue(item: OtlpHttpJsonItem): Promise<void> {
		const res = this.tryEnqueueInner(item, { allowBlock: true })
		if (res.ok) return
		if (!res.shouldBlock) return

		const maxItems = Math.max(1, Math.floor(this.queueCfg.maxQueuedRecords))
		const maxBytes = Math.max(1, Math.floor(this.queueCfg.maxQueuedBytes))
		const fits = () => this.queuedCount() < maxItems && this.queuedBytes + item.bytes <= maxBytes

		await new Promise<void>((resolve) => {
			this.waiting.push(resolve)
			this.kickFlush()
		})

		if (!this.enabled) return
		if (fits()) {
			this.queued.push(item)
			this.queuedBytes += item.bytes
			this.afterEnqueue()
			return
		}

		this.dropped++
		this.droppedQueueFull++
	}

	async flush(): Promise<void> {
		if (!this.enabled) return
		this.clearTimers()

		while (this.inflight > 0) await this.waitForIdle()
		while (this.queuedCount() > 0) {
			const now = Date.now()
			if (this.backoffUntilMs > now) {
				await new Promise((r) => setTimeout(r, this.backoffUntilMs - now))
			}
			await this.kickFlush({ drain: true })
		}
	}

	private async kickFlush(opts?: { drain?: boolean }): Promise<void> {
		this.clearTimers()
		if (!this.enabled) return
		if (this.queuedCount() === 0) return
		if (this.backoffUntilMs > Date.now()) {
			this.scheduleFlush()
			return
		}

		if (opts?.drain) {
			if (this.inflight !== 0) return
			const batch = this.takeBatch()
			this.releaseWaiters()
			if (batch.length === 0) return
			await this.sendBatchSafe(batch)
			if (this.queued.length > 0) return await this.kickFlush(opts)
			return
		}

		this.flushPending = true
		if (this.flushRunning) return
		this.flushRunning = true
		try {
			while (this.flushPending) {
				this.flushPending = false

				const maxInflight = Math.max(1, Math.floor(this.batch.maxInflight))
				while (this.inflight < maxInflight && this.queuedCount() > 0) {
					const batch = this.takeBatch()
					this.releaseWaiters()
					if (batch.length === 0) break
					void this.sendBatchSafe(batch).finally(() => {
						if (this.queuedCount() > 0) this.kickFlush()
						else this.notifyIdle()
					})
				}

				if (this.queuedCount() > 0) {
					if (!this.shouldFlushNow()) this.scheduleFlush()
				}
			}
		} finally {
			this.flushRunning = false
		}
	}

	private async sendBatchSafe(batch: OtlpHttpJsonItem[]): Promise<void> {
		this.inflight++
		try {
			const body = this.buildBody(batch)
			await this.sendRequest(body, this.timeoutMs)
			this.sentBatches++
			this.sentItems += batch.length
			this.consecutiveSendFailures = 0
			this.backoffUntilMs = 0
		} catch (error) {
			const now = Date.now()
			this.lastError = {
				at: now,
				message: error instanceof Error ? error.message : String(error),
			}
			this.dropped += batch.length
			this.consecutiveSendFailures += 1
			const backoffMs = Math.min(30_000, 500 * Math.pow(2, Math.min(10, this.consecutiveSendFailures - 1)))
			this.backoffUntilMs = Math.max(this.backoffUntilMs, now + backoffMs)

			if (now - this.lastFlushWarnAtMs >= 10_000) {
				this.lastFlushWarnAtMs = now
				this.warn('OTLP flush failed (batch dropped)', {
					signal: this.signal,
					backoffMs,
					nextRetryAt: this.backoffUntilMs,
					error,
				})
			}
		} finally {
			this.inflight--
			if (this.inflight === 0) this.notifyIdle()
		}

		if (this.queuedCount() === 0) return
		if (!this.shouldFlushNow()) this.scheduleFlush()
	}
}

