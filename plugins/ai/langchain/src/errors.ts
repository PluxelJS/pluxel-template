export type LangChainErrorCode = 'E_INVALID_INPUT' | 'E_UNSUPPORTED_PROVIDER' | 'E_INTERNAL'

export type LangChainError = Readonly<{
	code: LangChainErrorCode
	message: string
	details?: Record<string, unknown>
}>

export function lcError(code: LangChainErrorCode, message: string, details?: Record<string, unknown>): LangChainError {
	return { code, message, ...(details ? { details } : {}) }
}

export function lcErrorToError(e: LangChainError): Error {
	const out = new Error(`[lc] ${e.code}: ${e.message}`)
	;(out as any).code = e.code
	;(out as any).details = e.details
	return out
}

