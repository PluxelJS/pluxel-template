import { BasePlugin, Plugin } from '@pluxel/hmr'

import { registerUniverWorkbooksHttp } from './workbooks.http'
import { UniverWorkbooksRpc } from './workbooks.rpc'
import { UniverWorkbooksStore } from './workbooks.store'

@Plugin({ name: 'UniverWorkbooks', type: 'service' })
export class UniverWorkbooksPlugin extends BasePlugin {
	private store: UniverWorkbooksStore | null = null
	private readyResolve: (() => void) | null = null
	private readyReject: ((error: unknown) => void) | null = null
	private readonly readyPromise = new Promise<void>((resolve, reject) => {
		this.readyResolve = resolve
		this.readyReject = reject
	})

	getStore(): UniverWorkbooksStore | null {
		return this.store
	}

	requireStore(): UniverWorkbooksStore {
		if (!this.store) throw new Error('[univer] workbooks store not initialized')
		return this.store
	}

	ready(): Promise<void> {
		return this.readyPromise
	}

	override async init(_abort: AbortSignal): Promise<void> {
		try {
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

			this.readyResolve?.()
		} catch (error) {
			this.readyReject?.(error)
			throw error
		} finally {
			this.readyResolve = null
			this.readyReject = null
		}
	}
}

export default UniverWorkbooksPlugin

export { UniverWorkbooksStore } from './workbooks.store'

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
