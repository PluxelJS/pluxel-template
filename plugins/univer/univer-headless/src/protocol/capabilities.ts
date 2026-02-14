export const UNIVER_CAP_AI = 'univer.ai' as const
export const UNIVER_CAP_LOOPBACK = 'univer.loopback' as const

export type UniverCapabilityResult<T = unknown> = Readonly<{ ok: true; value: T } | { ok: false; error: string }>

export type UniverCapabilitiesSnapshot = Readonly<{
	at: number
	items: Record<string, UniverCapabilityResult>
}>
