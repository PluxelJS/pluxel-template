import { RpcTarget } from '@pluxel/hmr/capnweb'
import type {
	UniverBrowseFolderResult,
	UniverBeginSaveInput,
	UniverBeginSaveResult,
	UniverCommitSaveInput,
	UniverCommitSaveResult,
	UniverFolderMeta,
	UniverOpenWorkbookResult,
	UniverWorkbookMeta,
} from './workbooks.store'
import type { UniverWorkbooksStore } from './workbooks.store'

export class UniverWorkbooksRpc extends RpcTarget {
	constructor(private readonly store: UniverWorkbooksStore) {
		super()
	}

	listWorkbooks(): UniverWorkbookMeta[] {
		return this.store.list()
	}

	listFolders(): UniverFolderMeta[] {
		return this.store.listFolders()
	}

	browseFolder(folderId: string | null): UniverBrowseFolderResult {
		return this.store.browseFolder(folderId)
	}

	createFolder(input: { name: string; parentId?: string | null }): UniverFolderMeta {
		return this.store.createFolder(input)
	}

	renameFolder(id: string, name: string): UniverFolderMeta {
		return this.store.renameFolder(id, name)
	}

	deleteFolder(id: string, opts?: { recursive?: boolean }): { ok: true } {
		return this.store.deleteFolder(id, opts)
	}

	createWorkbook(input?: { name?: string; folderId?: string | null }): UniverWorkbookMeta {
		return this.store.createWorkbook(input)
	}

	renameWorkbook(id: string, name: string): UniverWorkbookMeta {
		return this.store.renameWorkbook(id, name)
	}

	moveWorkbook(id: string, folderId: string | null): UniverWorkbookMeta {
		return this.store.moveWorkbook(id, folderId)
	}

	deleteWorkbook(id: string): { ok: true } {
		return this.store.deleteWorkbook(id)
	}

	openWorkbook(id: string): UniverOpenWorkbookResult {
		return this.store.openWorkbook(id)
	}

	beginSave(input: UniverBeginSaveInput): UniverBeginSaveResult {
		return this.store.beginSave(input)
	}

	commitSave(input: UniverCommitSaveInput): UniverCommitSaveResult {
		return this.store.commitSave(input)
	}
}

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			UniverWorkbooks: UniverWorkbooksRpc
		}
	}
}
