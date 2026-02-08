import type { BaseChatMessageHistory } from '@langchain/core/chat_history'
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history'
import type { Runnable } from '@langchain/core/runnables'
import { RunnableWithMessageHistory } from '@langchain/core/runnables'

export type SessionId = string

export type InMemoryHistoryOptions = Readonly<{
	/** Max messages to keep per session (best-effort). */
	maxMessages?: number
}>

/**
 * Creates an in-memory LangChain message history factory keyed by `sessionId`.
 *
 * Notes:
 * - This does not persist prompts; it resets on reload.
 * - If `maxMessages` is set, we attempt to trim after writes (best-effort).
 */
export function createInMemoryHistoryFactory(opts?: InMemoryHistoryOptions): (sessionId: SessionId) => BaseChatMessageHistory {
	const store = new Map<string, InMemoryChatMessageHistory>()
	const max = typeof opts?.maxMessages === 'number' && Number.isFinite(opts.maxMessages) ? Math.max(1, Math.trunc(opts.maxMessages)) : null

	return (sessionId: string) => {
		const key = String(sessionId ?? '').trim()
		if (!key) throw new Error('[lc] sessionId must be non-empty')

		let history = store.get(key)
		if (!history) {
			history = new InMemoryChatMessageHistory()
			if (max) {
				const originalAdd = history.addMessage.bind(history)
				history.addMessage = (async (message: any) => {
					await originalAdd(message)
					try {
						const msgs = await history!.getMessages()
						if (msgs.length > max) {
							;(history as any).messages = msgs.slice(-max)
						}
					} catch {
						// best-effort trim only
					}
				}) as any
			}
			store.set(key, history)
		}

		return history
	}
}

export type WithHistoryOptions = Readonly<{
	/**
	 * Which input key carries new messages; defaults to `input`.
	 * Use this when wrapping chains that accept `{ messages }` etc.
	 */
	inputMessagesKey?: string
	/** Which output key carries messages; optional. */
	outputMessagesKey?: string
	/** Which key carries historical messages; defaults to `history`. */
	historyMessagesKey?: string
}>

/**
 * Wraps a runnable/model with session message history (LangChain-native).
 *
 * This helper keeps the plugin surface small while enabling real session workflows when you need them.
 */
export function withSessionHistory<TInput = any, TOutput = any>(
	runnable: Runnable<TInput, TOutput>,
	getHistory: (sessionId: SessionId) => BaseChatMessageHistory | Promise<BaseChatMessageHistory>,
	opts?: WithHistoryOptions,
): Runnable<TInput, TOutput> {
	return new RunnableWithMessageHistory({
		runnable,
		getMessageHistory: (sessionId: string) => getHistory(sessionId),
		inputMessagesKey: opts?.inputMessagesKey ?? 'input',
		outputMessagesKey: opts?.outputMessagesKey,
		historyMessagesKey: opts?.historyMessagesKey ?? 'history',
	}) as any
}

/**
 * Returns a runnable bound to a fixed `sessionId` via `.withConfig(...)`.
 *
 * Equivalent to passing `{ configurable: { sessionId } }` at every `.invoke/.stream` call.
 */
export function bindSessionId<TInput = any, TOutput = any>(runnable: Runnable<TInput, TOutput>, sessionId: SessionId): Runnable<TInput, TOutput> {
	const sid = String(sessionId ?? '').trim()
	if (!sid) throw new Error('[lc] sessionId must be non-empty')
	return runnable.withConfig({ configurable: { sessionId: sid } } as any) as any
}
