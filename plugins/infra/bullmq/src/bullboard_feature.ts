import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { HonoAdapter } from '@bull-board/hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { BaseFeature } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import type { EffectGuard, Effects } from '@pluxel/core/services'
import type { Queue } from 'bullmq'

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

const BullBoardConfigSchema = v.object({
	basePath: v.optional(v.string(), '/bullmq'),
	uiConfig: v.optional(v.record(v.string(), v.any()), {}),
})

export class BullBoardFeature extends BaseFeature {
	static featureKey = 'bullboard'

	readonly config = this.configs.use(BullBoardConfigSchema)

	mount(options: BullBoardMountOptions): BullBoardMountHandle {
		const basePath = normalizeBasePath(options.basePath ?? this.config.basePath ?? '/bullmq')
		const uiConfig = options.uiConfig ?? this.config.uiConfig ?? {}

		const adapter = new HonoAdapter(options.serveStatic ?? serveStatic)
		const api = createBullBoard({
			queues: options.queues.map((queue) => new BullMQAdapter(queue)),
			serverAdapter: adapter,
			options: { uiConfig },
		})

		adapter.setBasePath(basePath)
		const unmount = this.ctx.honoService.modifyApp((app) => {
			app.route(basePath, adapter.registerPlugin())
		})

		const label = `bullboard:${basePath}`
		const ownerEffects: Effects | null = this.ctx.caller?.effects ?? null

		let selfGuard!: EffectGuard
		let ownerGuard: EffectGuard | null = null

		const disposeFromOwner = () => {
			unmount()
			selfGuard.cancel()
		}

		const disposeFromSelf = () => {
			unmount()
			ownerGuard?.cancel()
		}

		selfGuard = this.ctx.effects.defer(disposeFromSelf, { tag: `bullmq:${label}:self` })
		if (ownerEffects) ownerGuard = ownerEffects.defer(disposeFromOwner, { tag: `bullmq:${label}:owner` })

		return {
			api,
			adapter,
			basePath,
			dispose: () => {
				unmount()
				selfGuard.cancel()
				ownerGuard?.cancel()
			},
		}
	}
}

function normalizeBasePath(input: string): string {
	const raw = String(input ?? '').trim()
	if (!raw || raw === '/') return '/bullmq'
	const withSlash = raw.startsWith('/') ? raw : `/${raw}`
	return withSlash.replace(/\/+$/, '')
}
