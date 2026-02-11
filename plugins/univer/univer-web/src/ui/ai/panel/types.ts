import type { Message as AiMessage } from '@douyinfe/semi-ui-19/lib/es/aiChatDialogue/interface'
import type { UniverAiContext } from '@pluxel/univer-headless/protocol'

import type { UniverRuntime } from '../../univer/runtime'
import type { LoopbackBackend } from '../loopback-backend'

export type AiPanelDevState = {
	instruction?: string
	chats?: AiMessage[]
	pinnedSelections?: UniverAiContext[]
	currentSelection?: UniverAiContext | null
	/** Write scope mode in the UI. */
	writeScopeMode?: 'sheet' | 'ranges'
	/** Explicit write scopes when writeScopeMode='ranges'. */
	writeScopes?: string[]
	/** Loopback max tool-call steps (server-side; maps to Ax maxSteps). */
	loopMaxRounds?: number
	mode?: 'safe' | 'aggressive'
}

export type AiPanelProps = {
	ready: boolean
	workbookId: string
	getRuntime(): UniverRuntime | null
	/**
	 * A monotonically increasing number that MUST change whenever `getRuntime()`
	 * starts returning a different UniverRuntime instance.
	 *
	 * This lets the panel re-bind Univer events/render hooks when the runtime is recreated
	 * (e.g. toggling frontend plugins in the host app).
	 */
	runtimeSeq?: number
	backend: LoopbackBackend | null
	/** Reload the editor from the latest snapshot. */
	onReloadLatest?: () => void
	/** When dirty, backend loopback runs on a stale snapshot. Disable in that case. */
	dirty?: boolean
	dev?: AiPanelDevState
}

export type { LoopbackBackend }
