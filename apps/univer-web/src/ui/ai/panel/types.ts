import type { Message as AiMessage } from '@douyinfe/semi-ui-19/lib/es/aiChatDialogue/interface'
import type { UniverAiChangeSet, UniverAiContext, UniverAiSuggestEditsResult } from 'pluxel-plugin-univer-ai'

import type { UniverRuntime } from '../../univer/runtime'
import type { UniverAiFrontendApi } from '../ai-contract'

export type AiPanelDevState = {
	instruction?: string
	chats?: AiMessage[]
	changeSet?: UniverAiChangeSet | null
	meta?: UniverAiSuggestEditsResult['meta'] | null
	pinnedSelections?: UniverAiContext[]
	currentSelection?: UniverAiContext | null
	autoSync?: boolean
	previewMode?: 'overlay' | 'inSheet'
	hoverPopup?: boolean
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
	api: UniverAiFrontendApi | null
	dev?: AiPanelDevState
}

export type ChangeState = 'idle' | 'preview' | 'applied' | 'rejected'
