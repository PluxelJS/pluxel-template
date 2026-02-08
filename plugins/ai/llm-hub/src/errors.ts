import type { Result } from './result'
import { err } from './result'

export type LLMErrorCode =
	| 'E_INVALID_INPUT'
	| 'E_PROFILE_NOT_FOUND'
	| 'E_PROFILE_DISABLED'
	| 'E_NO_USABLE_PROFILE'
	| 'E_MISSING_API_KEY'
	| 'E_CIRCUIT_OPEN'
	| 'E_PROVIDER_UNAVAILABLE'
	| 'E_INTERNAL'

export type LLMError = Readonly<{
	code: LLMErrorCode
	message: string
	details?: Record<string, unknown>
}>

export function llmError(code: LLMErrorCode, message: string, details?: Record<string, unknown>): LLMError {
	return { code, message, ...(details ? { details } : {}) }
}

export function llmErr<T>(code: LLMErrorCode, message: string, details?: Record<string, unknown>): Result<T, LLMError> {
	return err(llmError(code, message, details))
}

export function llmErrorToError(e: LLMError): Error {
	const message = `[llm] ${e.code}: ${e.message}`
	const out = new Error(message)
	;(out as any).code = e.code
	;(out as any).details = e.details
	return out
}

export function asLLMErrorResult<T = never>(e: unknown, fallbackMessage = 'internal error'): Result<T, LLMError> {
	return err(asLLMError(e, fallbackMessage))
}

export function asLLMError(e: unknown, fallbackMessage = 'internal error'): LLMError {
	if (e && typeof e === 'object') {
		const code = (e as any).code
		const message = (e as any).message
		const details = (e as any).details
		if (typeof code === 'string' && typeof message === 'string') {
			return llmError(code as any, message, typeof details === 'object' && details && !Array.isArray(details) ? details : undefined)
		}
	}
	const message = typeof (e as any)?.message === 'string' ? (e as any).message : fallbackMessage
	return llmError('E_INTERNAL', message)
}
