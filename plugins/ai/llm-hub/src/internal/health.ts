import type { LLMCircuitConfig, LLMProfileDoc, LLMProfileHealth } from '../profiles'
import { defaultCircuitConfig, defaultHealth } from '../profiles'
import type { LLMHubSettingsDoc } from '../settings'

export type LLMUpstreamFailure = Readonly<{ code: string; message: string }>

export const isFailureStatus = (status: number) => status === 401 || status === 403 || status === 429 || status >= 500

export function effectiveCircuitConfig(doc: LLMProfileDoc, settings: LLMHubSettingsDoc): LLMCircuitConfig {
	const base = settings.circuit ?? defaultCircuitConfig()
	const override = doc.circuit ?? {}
	return {
		...base,
		...(override.enabled !== undefined ? { enabled: !!override.enabled } : {}),
		...(typeof override.failureThreshold === 'number' ? { failureThreshold: override.failureThreshold } : {}),
		...(typeof override.openMs === 'number' ? { openMs: override.openMs } : {}),
	}
}

export function effectiveHealth(doc: LLMProfileDoc): LLMProfileHealth {
	return { ...defaultHealth(), ...(doc.health ?? {}) }
}

export function isCircuitOpen(health: LLMProfileHealth, now = Date.now()): boolean {
	return typeof health.openUntil === 'number' && health.openUntil > now
}

export function healthOnSuccess(prev: LLMProfileHealth, now: number): LLMProfileHealth | null {
	if (prev.consecutiveFailures === 0 && !prev.openUntil) return null
	return {
		...prev,
		consecutiveFailures: 0,
		openUntil: undefined,
		lastSuccessAt: now,
	}
}

export function healthOnFailure(prev: LLMProfileHealth, circuit: LLMCircuitConfig, failure: LLMUpstreamFailure, now: number): LLMProfileHealth {
	// When the circuit cools down (openUntil <= now), start a new streak so a single
	// post-cooldown failure doesn't instantly re-open the circuit.
	const cooledDown = typeof prev.openUntil === 'number' && prev.openUntil <= now
	const baseFailures = cooledDown ? 0 : prev.consecutiveFailures
	const consecutiveFailures = baseFailures + 1
	const shouldOpen = circuit.enabled && consecutiveFailures >= circuit.failureThreshold
	const openUntil = shouldOpen ? now + circuit.openMs : undefined

	return {
		...prev,
		consecutiveFailures,
		lastFailureAt: now,
		lastFailureCode: failure.code,
		lastFailureMessage: failure.message,
		openUntil,
	}
}

