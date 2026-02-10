import type { EffectGuard, Effects } from '@pluxel/core/services'
import type { Closeable, TrackOptions } from './bullmq_types'

export type ManagedResource = {
	resource: Closeable
	closeOnStop: boolean
	label: string
	selfGuard: EffectGuard
	ownerGuard: EffectGuard | null
}

type CtxLike = {
	effects: Effects
	caller?: { effects?: Effects } | null
	logger: { debug: (msg: string, props?: Record<string, unknown>) => void }
}

function resolveOwnerEffects(ctx: CtxLike, options?: TrackOptions): Effects | null {
	if (!options) return ctx.caller?.effects ?? null
	if (!options.owner) return options.effects ?? ctx.caller?.effects ?? null

	if (options.owner === 'plugin') return null
	if (options.owner === 'caller') return ctx.caller?.effects ?? null

	// custom
	if (!options.effects) throw new Error('[BullMQ] TrackOptions.owner="custom" requires TrackOptions.effects')
	return options.effects
}

export function trackResource<T extends Closeable>(
	ctx: CtxLike,
	map: Map<Closeable, ManagedResource>,
	resource: T,
	track: TrackOptions | false | undefined,
	fallbackLabel: string,
): T {
	if (map.has(resource)) return resource
	if (track === false) return resource

	const label = track?.label?.trim() || fallbackLabel
	const closeOnStop = track?.closeOnStop ?? true
	const ownerEffects = resolveOwnerEffects(ctx, track)

	const record: ManagedResource = {
		resource,
		closeOnStop,
		label,
		selfGuard: undefined as any,
		ownerGuard: null,
	}
	map.set(resource, record)

	const close = () =>
		resource.close().catch((error) => {
			ctx.logger.debug('close failed ({label})', { label, error })
		})

	const cleanupFromOwner = () => {
		if (!map.delete(resource)) return
		void close()
		record.selfGuard.cancel()
	}

	const cleanupFromSelf = () => {
		if (!map.delete(resource)) return
		if (record.closeOnStop) void close()
		record.ownerGuard?.cancel()
	}

	record.selfGuard = ctx.effects.defer(cleanupFromSelf, { tag: `bullmq:track:self:${label}` })
	if (ownerEffects) record.ownerGuard = ownerEffects.defer(cleanupFromOwner, { tag: `bullmq:track:owner:${label}` })
	return resource
}

export function untrackResource(map: Map<Closeable, ManagedResource>, resource: Closeable): boolean {
	const rec = map.get(resource)
	if (!rec) return false
	map.delete(resource)
	rec.selfGuard.cancel()
	rec.ownerGuard?.cancel()
	return true
}
