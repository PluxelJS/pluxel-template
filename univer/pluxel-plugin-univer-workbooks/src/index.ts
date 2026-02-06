import { BasePlugin, Plugin } from '@pluxel/hmr'

import { registerUniverWorkbooksHttp } from './workbooks.http'
import { UniverWorkbooksRpc } from './workbooks.rpc'
import { UniverWorkbooksStore } from './workbooks.store'

@Plugin({ name: 'UniverWorkbooks', type: 'service' })
export class UniverWorkbooksPlugin extends BasePlugin {
	private store: UniverWorkbooksStore | null = null

	override async init(_abort: AbortSignal): Promise<void> {
		this.store = await UniverWorkbooksStore.create(this.ctx)

		// HTTP data plane.
		try {
			const off = registerUniverWorkbooksHttp(this.ctx, this.store)
			this.ctx.effects.defer(off)
		} catch (error) {
			this.ctx.logger.warn('UniverWorkbooks HTTP routes registration skipped', { error })
		}

		// Control plane (RPC).
		try {
			this.ctx.ext.rpc.registerExtension(() => new UniverWorkbooksRpc(this.store!))
		} catch (error) {
			// Allow running in minimal/test hosts without ext.rpc.
			this.ctx.logger.warn('UniverWorkbooks RPC registration skipped', { error })
		}
	}
}

export default UniverWorkbooksPlugin

export type {
	UniverAutosavePolicy,
	UniverBrowseFolderResult,
	UniverBeginSaveConflict,
	UniverBeginSaveInput,
	UniverBeginSaveOk,
	UniverBeginSaveResult,
	UniverCommitSaveConflict,
	UniverCommitSaveInput,
	UniverCommitSaveOk,
	UniverCommitSaveResult,
	UniverFolderMeta,
	UniverOpenWorkbookResult,
	UniverWorkbookMeta,
} from './workbooks.store'
