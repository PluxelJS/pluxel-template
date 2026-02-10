/**
 * Univer global capabilities snapshot (Service -> UI).
 *
 * This is intentionally generic: feature plugins can register capability providers
 * without bloating the shared protocol types.
 */
export type UniverCapabilityResult = Readonly<
	{ ok: true; value: unknown } | { ok: false; error: string }
>

export type UniverCapabilitiesSnapshot = Readonly<{
	updatedAt: number
	items: Record<string, UniverCapabilityResult>
}>
