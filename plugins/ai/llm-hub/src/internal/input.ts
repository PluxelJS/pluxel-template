import { llmError } from '../errors'
import type { LLMCircuitConfig } from '../profiles'

export function normalizeRequiredString(field: string, raw: unknown): string {
	const s = String(raw ?? '').trim()
	if (!s) throw llmError('E_INVALID_INPUT', `${field} must be non-empty`)
	return s
}

export function normalizeOptionalString(raw: unknown): string | undefined {
	const s = typeof raw === 'string' ? raw.trim() : ''
	return s || undefined
}

export function normalizeOptionalStringOrNull(raw: unknown): string | null | undefined {
	if (raw === null) return null
	return normalizeOptionalString(raw)
}

export function normalizeObject(field: string, raw: unknown): Record<string, unknown> {
	if (!raw) return {}
	if (typeof raw !== 'object' || Array.isArray(raw)) throw llmError('E_INVALID_INPUT', `${field} must be an object`)
	return raw as Record<string, unknown>
}

export function normalizePriority(raw: unknown): number {
	const n = typeof raw === 'number' ? raw : Number(raw)
	if (!Number.isFinite(n)) return 0
	return Math.max(-1_000_000, Math.min(1_000_000, Math.trunc(n)))
}

export function normalizeCircuitConfig(input?: Partial<LLMCircuitConfig>): Partial<LLMCircuitConfig> | undefined {
	if (!input) return undefined
	const next: Partial<LLMCircuitConfig> = {}
	if (input.enabled !== undefined) next.enabled = !!input.enabled
	if (input.failureThreshold !== undefined) {
		const n = Number(input.failureThreshold)
		if (Number.isFinite(n)) next.failureThreshold = Math.max(1, Math.min(100, Math.trunc(n)))
	}
	if (input.openMs !== undefined) {
		const n = Number(input.openMs)
		if (Number.isFinite(n)) next.openMs = Math.max(1_000, Math.min(60 * 60_000, Math.trunc(n)))
	}
	return Object.keys(next).length ? next : undefined
}
