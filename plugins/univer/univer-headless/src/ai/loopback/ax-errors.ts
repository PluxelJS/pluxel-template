const MAX_PREVIEW_CHARS = 2000

export type AxUpstreamErrorDetails = Readonly<{
	status?: number
	statusText?: string
	url?: string
	errorId?: string
	timestamp?: string
	requestSummary?: string
	requestBodyPreview?: string
	responseBodyPreview?: string
}>

function truncate(input: string, maxChars: number): string {
	if (input.length <= maxChars) return input
	return `${input.slice(0, Math.max(0, maxChars - 1))}…`
}

function safeJsonPreview(value: unknown, maxChars: number): string | undefined {
	if (value == null) return undefined
	if (typeof value === 'string') return truncate(value, maxChars)
	try {
		return truncate(JSON.stringify(value, null, 2), maxChars)
	} catch {
		try {
			return truncate(String(value), maxChars)
		} catch {
			return undefined
		}
	}
}

function summarizeRequestBody(value: unknown): string | undefined {
	const rec = asRecord(value)
	if (!rec) return undefined

	const hasMessages = Array.isArray((rec as any).messages)
	const hasTools = Array.isArray((rec as any).tools)
	const toolsCount = hasTools ? ((rec as any).tools as unknown[]).length : 0
	const messagesCount = hasMessages ? ((rec as any).messages as unknown[]).length : 0
	const roles =
		hasMessages && messagesCount
			? Array.from(
					new Set(
						((rec as any).messages as any[])
							.map((m) => (m && typeof m === 'object' ? String((m as any).role ?? '') : ''))
							.filter(Boolean),
					),
				).join(',')
			: ''

	const interesting = [
		'model',
		'stream',
		'max_tokens',
		'temperature',
		'top_p',
		'n',
		'stop',
		'tool_choice',
		'response_format',
		'parallel_tool_calls',
		'presence_penalty',
		'frequency_penalty',
		'logprobs',
		'top_logprobs',
		'seed',
	]
	const present = interesting.filter((k) => k in rec)
	const keysSummary = present.length ? present.join(',') : Object.keys(rec).sort().slice(0, 12).join(',')

	const parts: string[] = []
	parts.push(`keys=${keysSummary || '(none)'}`)
	if (typeof (rec as any).model === 'string' && String((rec as any).model).trim()) parts.push(`model=${String((rec as any).model)}`)
	if (typeof (rec as any).stream === 'boolean') parts.push(`stream=${String((rec as any).stream)}`)
	if (hasMessages) parts.push(`messages=${messagesCount}${roles ? ` roles=${roles}` : ''}`)
	if (hasTools) parts.push(`tools=${toolsCount}`)
	if ('tool_choice' in rec)
		parts.push(`tool_choice=${typeof (rec as any).tool_choice === 'string' ? String((rec as any).tool_choice) : 'object'}`)
	if ('response_format' in rec)
		parts.push(
			`response_format=${typeof (rec as any).response_format === 'string' ? String((rec as any).response_format) : 'object'}`,
		)
	return parts.join(' · ')
}

function redactRequestBodyForPreview(value: unknown): unknown {
	const rec = asRecord(value)
	if (!rec) return value

	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(rec)) {
		if (k === 'messages' || k === 'tools' || k === 'functions') continue
		out[k] = v
	}

	const messages = (rec as any).messages
	if (Array.isArray(messages)) {
		out.messages = messages.map((m) => {
			if (!m || typeof m !== 'object') return { type: typeof m }
			const role = typeof (m as any).role === 'string' ? (m as any).role : undefined
			const name = typeof (m as any).name === 'string' ? (m as any).name : undefined
			const toolCallId = typeof (m as any).tool_call_id === 'string' ? (m as any).tool_call_id : undefined
			const content = (m as any).content
			const contentHint =
				typeof content === 'string'
					? `[redacted string len=${content.length}]`
					: Array.isArray(content)
						? `[redacted parts len=${content.length}]`
						: content == null
							? null
							: `[redacted ${typeof content}]`
			return {
				...(role ? { role } : {}),
				...(name ? { name } : {}),
				...(toolCallId ? { tool_call_id: toolCallId } : {}),
				content: contentHint,
			}
		})
	}

	const tools = (rec as any).tools
	if (Array.isArray(tools)) {
		out.tools = tools.map((t) => {
			if (!t || typeof t !== 'object') return { type: typeof t }
			const type = typeof (t as any).type === 'string' ? (t as any).type : undefined
			const fn = (t as any).function
			const fnName = fn && typeof fn === 'object' && typeof fn.name === 'string' ? fn.name : undefined
			return { ...(type ? { type } : {}), ...(fnName ? { name: fnName } : {}) }
		})
	}

	const functions = (rec as any).functions
	if (Array.isArray(functions)) {
		out.functions = functions.map((f) => {
			if (!f || typeof f !== 'object') return { type: typeof f }
			const name = typeof (f as any).name === 'string' ? (f as any).name : undefined
			return { ...(name ? { name } : {}) }
		})
	}

	return out
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object') return null
	return value as Record<string, unknown>
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key]
	if (typeof v === 'string' && v.trim()) return v
	return undefined
}

function pickNumber(obj: Record<string, unknown>, key: string): number | undefined {
	const v = obj[key]
	if (typeof v === 'number' && Number.isFinite(v)) return v
	return undefined
}

function getCause(error: unknown): unknown {
	const r = asRecord(error)
	if (!r) return undefined
	return r.cause
}

function findPluxelUpstreamHttpError(input: unknown): Record<string, unknown> | null {
	const seen = new Set<unknown>()
	const stack: unknown[] = [input]
	while (stack.length) {
		const cur = stack.pop()
		if (!cur || typeof cur !== 'object') continue
		if (seen.has(cur)) continue
		seen.add(cur)

		const rec = asRecord(cur)
		if (!rec) continue
		if (pickString(rec, 'name') === 'PluxelUpstreamHttpError') return rec

		const cause = (rec as any).cause
		const originalError = (rec as any).originalError
		const context = (rec as any).context

		if (cause) stack.push(cause)
		if (originalError) stack.push(originalError)
		if (context) stack.push(context)

		// Best-effort: some wrappers store the original error under different keys.
		for (const k of ['err', 'error', 'upstreamError', 'innerError', 'original', 'rawError']) {
			const v = (rec as any)[k]
			if (v) stack.push(v)
		}
	}
	return null
}

export function extractAxUpstreamErrorDetails(error: unknown): AxUpstreamErrorDetails | null {
	// We intentionally use "duck typing" because multiple copies of @ax-llm/ax may exist in a Pluxel workspace.
	// - AxGenerateError: { name: 'AxGenerateError', details, cause? }
	// - AxAIServiceStatusError: { name: 'AxAIServiceStatusError', status, statusText, url, requestBody, responseBody, errorId, timestamp }
	const errRec = asRecord(error)
	const cause = getCause(error)

	const candidates: unknown[] = [cause, error]
	for (const c of candidates) {
		const rec = asRecord(c)
		if (!rec) continue
		const name = pickString(rec, 'name')
		if (name === 'PluxelUpstreamHttpError') {
			const status = pickNumber(rec, 'status')
			const statusText = pickString(rec, 'statusText')
			const url = pickString(rec, 'url')
			const bodyText = pickString(rec, 'bodyText') ?? ''
			const responseBodyPreview = bodyText ? safeJsonPreview(bodyText, MAX_PREVIEW_CHARS) : undefined
			return { status, statusText, url, responseBodyPreview }
		}
		if (name && name.startsWith('AxAIService')) {
			const errorId = pickString(rec, 'errorId')
			const timestamp = pickString(rec, 'timestamp')

			const requestBody = (rec as any).requestBody
			const requestSummary = summarizeRequestBody(requestBody)
			const requestBodyPreview = safeJsonPreview(redactRequestBodyForPreview(requestBody), MAX_PREVIEW_CHARS)

			// Prefer our buffered upstream payload (if fetch wrapper threw it) over Ax's responseBody (which can be "already read").
			let status = pickNumber(rec, 'status') ?? pickNumber(rec, 'httpStatus')
			let statusText = pickString(rec, 'statusText') ?? pickString(rec, 'httpStatusText')
			let url = pickString(rec, 'url')
			let responseBodyPreview = safeJsonPreview(rec.responseBody, MAX_PREVIEW_CHARS)

			const upstreamHttp = findPluxelUpstreamHttpError((rec as any).originalError) ?? findPluxelUpstreamHttpError(rec)
			if (upstreamHttp) {
				status = pickNumber(upstreamHttp, 'status') ?? status
				statusText = pickString(upstreamHttp, 'statusText') ?? statusText
				url = pickString(upstreamHttp, 'url') ?? url
				const bodyText = pickString(upstreamHttp, 'bodyText') ?? ''
				if (bodyText) responseBodyPreview = safeJsonPreview(bodyText, MAX_PREVIEW_CHARS) ?? responseBodyPreview
			}

			return { status, statusText, url, errorId, timestamp, requestSummary, requestBodyPreview, responseBodyPreview }
		}
	}

	if (errRec && pickString(errRec, 'name') === 'AxGenerateError') {
		// AxGenerateError itself doesn't carry upstream details, but expose a stable JSON if helpful.
		const preview = safeJsonPreview(errRec, MAX_PREVIEW_CHARS)
		return preview ? { responseBodyPreview: preview } : null
	}

	return null
}

export function formatLoopbackAxError(error: unknown): Readonly<{
	message: string
	upstream?: AxUpstreamErrorDetails
}> {
	const baseMessage = error instanceof Error ? error.message : String(error)
	const upstream = extractAxUpstreamErrorDetails(error) ?? undefined
	if (!upstream) return { message: baseMessage }

	const lines: string[] = [baseMessage]
	if (upstream.status || upstream.url) {
		const parts: string[] = []
		if (upstream.status) parts.push(`status=${upstream.status}${upstream.statusText ? ` ${upstream.statusText}` : ''}`)
		if (upstream.url) parts.push(`url=${upstream.url}`)
		lines.push(`Upstream: ${parts.join(' · ')}`)
	}
	if (upstream.errorId) lines.push(`UpstreamErrorId: ${upstream.errorId}`)
	if (upstream.requestSummary) lines.push(`UpstreamRequest: ${upstream.requestSummary}`)
	if (upstream.requestBodyPreview) lines.push(`UpstreamRequestPreview:\n${upstream.requestBodyPreview}`)
	if (upstream.responseBodyPreview) lines.push(`UpstreamBodyPreview:\n${upstream.responseBodyPreview}`)
	return { message: lines.join('\n'), upstream }
}
