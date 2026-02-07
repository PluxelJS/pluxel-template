import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@pluxel/hmr'
import { Collection, createIndex } from '@pluxel/hmr/signaldb'

export type UniverAutosavePolicy = Readonly<{
	debounceMs: number
	minIntervalMs: number
	maxIntervalMs: number
}>

export type UniverWorkbookMeta = Readonly<{
	id: string
	name: string
	folderId: string | null
	latestRev: number
	latestEtag: string | null
	updatedAt: number
	createdAt: number
}>

export type UniverFolderMeta = Readonly<{
	id: string
	name: string
	parentId: string | null
	updatedAt: number
	createdAt: number
}>

export type UniverBrowseFolderResult = Readonly<{
	cwd: UniverFolderMeta | null
	breadcrumbs: readonly UniverFolderMeta[]
	folders: readonly UniverFolderMeta[]
	workbooks: readonly UniverWorkbookMeta[]
}>

export type UniverOpenWorkbookResult = Readonly<{
	id: string
	name: string
	folderId: string | null
	latestRev: number
	latestEtag: string | null
	latestSnapshotUrl: string | null
	canEdit: boolean
	autosavePolicy: UniverAutosavePolicy
	updatedAt: number
}>

export type UniverBeginSaveInput = Readonly<{
	id: string
	baseRev: number
	sha256: string
	byteSize: number
}>

export type UniverBeginSaveOk = Readonly<{
	uploadUrl: string
	uploadId: string
	commitToken: string
	currentRev: number
}>

export type UniverBeginSaveConflict = Readonly<{
	conflict: true
	currentRev: number
	latestSnapshotUrl: string | null
	latestEtag: string | null
}>

export type UniverBeginSaveResult = UniverBeginSaveOk | UniverBeginSaveConflict

export type UniverCommitSaveInput = Readonly<{
	id: string
	uploadId: string
	commitToken: string
}>

export type UniverCommitSaveOk = Readonly<{
	newRev: number
	newSnapshotUrl: string
	newEtag: string
}>

export type UniverCommitSaveConflict = Readonly<{
	conflict: true
	currentRev: number
	latestSnapshotUrl: string | null
	latestEtag: string | null
}>

export type UniverCommitSaveResult = UniverCommitSaveOk | UniverCommitSaveConflict

type WorkbookMetaDoc = {
	id: string
	name: string
	folderId?: string | null
	latestRev: number
	latestEtag: string | null
	updatedAt: number
	createdAt: number
}

type FolderDoc = {
	id: string
	name: string
	parentId: string | null
	updatedAt: number
	createdAt: number
}

type SnapshotDoc = {
	id: string
	key: string
	rev: number
	etag: string
	json: string
	size: number
	createdAt: number
}

type UploadDoc = {
	id: string
	workbookId: string
	baseRev: number
	expectedSha256: string
	expectedSize: number
	commitToken: string
	expiresAt: number
	createdAt: number
	uploadedAt?: number
	uploadedJson?: string
	uploadedEtag?: string
	uploadedSize?: number
}

const COLLECTION_WORKBOOKS = 'univer-workbooks'
const COLLECTION_FOLDERS = 'univer-folders'
const COLLECTION_SNAPSHOTS = 'univer-snapshots'
const COLLECTION_UPLOADS = 'univer-uploads'

const DEFAULT_AUTOSAVE_POLICY: UniverAutosavePolicy = {
	debounceMs: 2500,
	minIntervalMs: 12_000,
	maxIntervalMs: 60_000,
}

const API_PREFIX = '/api/univer'

export class UniverWorkbooksStore {
	private constructor(
		private readonly ctx: Context,
		private readonly workbooks: Collection<WorkbookMetaDoc>,
		private readonly folders: Collection<FolderDoc>,
		private readonly snapshots: Collection<SnapshotDoc>,
		private readonly uploads: Collection<UploadDoc>,
	) {}

	static async create(ctx: Context) {
		const workbooks = new Collection<WorkbookMetaDoc>({
			name: COLLECTION_WORKBOOKS,
			persistence: await ctx.pluginData.persistenceForCollection<WorkbookMetaDoc>(COLLECTION_WORKBOOKS),
			indices: [createIndex('updatedAt'), createIndex('createdAt'), createIndex('folderId')],
		})
		const folders = new Collection<FolderDoc>({
			name: COLLECTION_FOLDERS,
			persistence: await ctx.pluginData.persistenceForCollection<FolderDoc>(COLLECTION_FOLDERS),
			indices: [createIndex('updatedAt'), createIndex('createdAt'), createIndex('parentId')],
		})
		const snapshots = new Collection<SnapshotDoc>({
			name: COLLECTION_SNAPSHOTS,
			persistence: await ctx.pluginData.persistenceForCollection<SnapshotDoc>(COLLECTION_SNAPSHOTS),
			indices: [createIndex('id'), createIndex('key')],
		})
		const uploads = new Collection<UploadDoc>({
			name: COLLECTION_UPLOADS,
			persistence: await ctx.pluginData.persistenceForCollection<UploadDoc>(COLLECTION_UPLOADS),
			indices: [createIndex('workbookId'), createIndex('expiresAt')],
		})
		await Promise.all([workbooks.isReady(), folders.isReady(), snapshots.isReady(), uploads.isReady()])
		const store = new UniverWorkbooksStore(ctx, workbooks, folders, snapshots, uploads)
		store.normalizeLegacyDocs()
		return store
	}

	private normalizeLegacyDocs() {
		// Best-effort normalization for older docs where optional fields may be missing.
		try {
			const wbs = this.workbooks.find().fetch()
			this.workbooks.batch(() => {
				for (const wb of wbs) {
					if (typeof wb.folderId === 'undefined') {
						this.workbooks.updateOne({ id: wb.id }, { $set: { folderId: null } })
					}
				}
			})

			const fds = this.folders.find().fetch()
			this.folders.batch(() => {
				for (const f of fds) {
					if (typeof (f as { parentId?: unknown }).parentId === 'undefined') {
						this.folders.updateOne({ id: f.id }, { $set: { parentId: null } })
					}
				}
			})
		} catch (error) {
			this.ctx.logger.warn('UniverWorkbooks legacy normalization skipped', { error })
		}
	}

	list(): UniverWorkbookMeta[] {
		const all = this.workbooks.find().fetch()
		all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
		return all.map((m) => ({
			id: m.id,
			name: m.name,
			folderId: normalizeFolderId(m.folderId),
			latestRev: m.latestRev,
			latestEtag: m.latestEtag ?? null,
			updatedAt: m.updatedAt,
			createdAt: m.createdAt,
		}))
	}

	listFolders(): UniverFolderMeta[] {
		const all = this.folders.find().fetch()
		all.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
		return all.map((f) => ({
			id: f.id,
			name: f.name,
			parentId: f.parentId ?? null,
			updatedAt: f.updatedAt,
			createdAt: f.createdAt,
		}))
	}

	browseFolder(folderId: string | null): UniverBrowseFolderResult {
		const cwd = folderId ? this.folders.findOne({ id: folderId }) : undefined
		if (folderId && !cwd) throw new Error(`[univer] folder not found: ${folderId}`)

		const folders = this.folders.find({ parentId: folderId ?? null }).fetch()
		folders.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))

		const workbooks = this.workbooks.find({ folderId: folderId ?? null }).fetch()
		workbooks.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

		return {
			cwd: cwd ? toFolderMeta(cwd) : null,
			breadcrumbs: folderId ? this.buildBreadcrumbs(folderId) : [],
			folders: folders.map(toFolderMeta),
			workbooks: workbooks.map(toWorkbookMeta),
		}
	}

	createFolder(input: { name: string; parentId?: string | null }): UniverFolderMeta {
		const name = String(input.name ?? '').trim()
		if (!name) throw new Error('[univer] folder name must be non-empty')
		const parentId = input.parentId ?? null
		if (parentId && !this.folders.findOne({ id: parentId })) throw new Error(`[univer] parent folder not found: ${parentId}`)

		const now = Date.now()
		const id = randomUUID()
		const doc: FolderDoc = { id, name, parentId, createdAt: now, updatedAt: now }
		this.folders.insert(doc)
		return toFolderMeta(doc)
	}

	renameFolder(id: string, name: string): UniverFolderMeta {
		const cur = this.folders.findOne({ id })
		if (!cur) throw new Error(`[univer] folder not found: ${id}`)
		const nextName = String(name ?? '').trim()
		if (!nextName) throw new Error('[univer] folder name must be non-empty')
		const updatedAt = Date.now()
		this.folders.updateOne({ id }, { $set: { name: nextName, updatedAt } })
		return { ...toFolderMeta(cur), name: nextName, updatedAt }
	}

	deleteFolder(id: string, opts?: { recursive?: boolean }): { ok: true } {
		const recursive = opts?.recursive ?? false
		const cur = this.folders.findOne({ id })
		if (!cur) throw new Error(`[univer] folder not found: ${id}`)

		const directFolders = this.folders.find({ parentId: id }).fetch()
		const directWorkbooks = this.workbooks.find({ folderId: id }).fetch()
		if (!recursive && (directFolders.length > 0 || directWorkbooks.length > 0)) {
			throw new Error('[univer] folder not empty')
		}

		const folderIds = recursive ? this.collectFolderDescendants(id) : [id]
		const wbIds = this.workbooks
			.find()
			.fetch()
			.filter((w) => {
				const fid = normalizeFolderId(w.folderId)
				return fid ? folderIds.includes(fid) : false
			})
			.map((w) => w.id)

		for (const wid of wbIds) this.deleteWorkbook(wid)
		for (const fid of folderIds.reverse()) this.folders.removeOne({ id: fid })

		return { ok: true }
	}

	moveWorkbook(id: string, folderId: string | null): UniverWorkbookMeta {
		const cur = this.workbooks.findOne({ id })
		if (!cur) throw new Error(`[univer] workbook not found: ${id}`)
		const nextFolderId = folderId ?? null
		if (nextFolderId && !this.folders.findOne({ id: nextFolderId })) throw new Error(`[univer] folder not found: ${nextFolderId}`)
		const updatedAt = Date.now()
		this.workbooks.updateOne({ id }, { $set: { folderId: nextFolderId, updatedAt } })
		return { ...toWorkbookMeta(cur), folderId: nextFolderId, updatedAt }
	}

	createWorkbook(input?: { name?: string; folderId?: string | null }): UniverWorkbookMeta {
		const folderId = input?.folderId ?? null
		if (folderId && !this.folders.findOne({ id: folderId })) throw new Error(`[univer] folder not found: ${folderId}`)
		const now = Date.now()
		const id = randomUUID()
		const doc: WorkbookMetaDoc = {
			id,
			name: String(input?.name ?? '').trim() || 'Untitled',
			folderId,
			latestRev: 0,
			latestEtag: null,
			updatedAt: now,
			createdAt: now,
		}
		this.workbooks.insert(doc)
		return toWorkbookMeta(doc)
	}

	renameWorkbook(id: string, name: string): UniverWorkbookMeta {
		const cur = this.workbooks.findOne({ id })
		if (!cur) throw new Error(`[univer] workbook not found: ${id}`)
		const nextName = String(name ?? '').trim()
		if (!nextName) throw new Error('[univer] workbook name must be non-empty')
		const updatedAt = Date.now()
		this.workbooks.updateOne({ id }, { $set: { name: nextName, updatedAt } })
		return { ...toWorkbookMeta(cur), name: nextName, updatedAt }
	}

	deleteWorkbook(id: string): { ok: true } {
		this.workbooks.removeOne({ id })
		this.snapshots.removeMany({ id })
		this.uploads.removeMany({ workbookId: id })
		return { ok: true }
	}

	openWorkbook(id: string): UniverOpenWorkbookResult {
		const meta = this.workbooks.findOne({ id })
		if (!meta) throw new Error(`[univer] workbook not found: ${id}`)
		return {
			id: meta.id,
			name: meta.name,
			folderId: normalizeFolderId(meta.folderId),
			latestRev: meta.latestRev,
			latestEtag: meta.latestEtag ?? null,
			latestSnapshotUrl: meta.latestRev > 0 ? this.snapshotUrl(meta.id, meta.latestRev) : null,
			canEdit: true,
			autosavePolicy: DEFAULT_AUTOSAVE_POLICY,
			updatedAt: meta.updatedAt,
		}
	}

	beginSave(input: UniverBeginSaveInput): UniverBeginSaveResult {
		const meta = this.workbooks.findOne({ id: input.id })
		if (!meta) throw new Error(`[univer] workbook not found: ${input.id}`)

		if (input.baseRev !== meta.latestRev) {
			return this.conflict(meta)
		}

		const uploadId = randomUUID()
		const commitToken = randomUUID()
		const now = Date.now()
		const expiresAt = now + 10 * 60 * 1000

		this.uploads.insert({
			id: uploadId,
			workbookId: meta.id,
			baseRev: input.baseRev,
			expectedSha256: input.sha256,
			expectedSize: input.byteSize,
			commitToken,
			expiresAt,
			createdAt: now,
		})

		return {
			uploadUrl: `${API_PREFIX}/workbooks/${encodeURIComponent(meta.id)}/uploads/${encodeURIComponent(uploadId)}?token=${encodeURIComponent(commitToken)}`,
			uploadId,
			commitToken,
			currentRev: meta.latestRev,
		}
	}

	commitSave(input: UniverCommitSaveInput): UniverCommitSaveResult {
		const meta = this.workbooks.findOne({ id: input.id })
		if (!meta) throw new Error(`[univer] workbook not found: ${input.id}`)

		const upload = this.uploads.findOne({ id: input.uploadId })
		if (!upload || upload.workbookId !== meta.id) throw new Error('[univer] upload not found')
		if (upload.commitToken !== input.commitToken) throw new Error('[univer] invalid commit token')
		if (Date.now() > upload.expiresAt) {
			this.uploads.removeOne({ id: upload.id })
			throw new Error('[univer] upload expired')
		}

		if (upload.baseRev !== meta.latestRev) {
			return this.conflict(meta)
		}

		const json = upload.uploadedJson
		const etag = upload.uploadedEtag
		const size = upload.uploadedSize
		if (!json || !etag || typeof size !== 'number') throw new Error('[univer] upload not completed')

		const newRev = meta.latestRev + 1
		const now = Date.now()
		const key = snapshotKey(meta.id, newRev)
		this.snapshots.insert({
			id: meta.id,
			key,
			rev: newRev,
			etag,
			json,
			size,
			createdAt: now,
		})

		this.workbooks.updateOne(
			{ id: meta.id },
			{ $set: { latestRev: newRev, latestEtag: etag, updatedAt: now } },
		)
		this.uploads.removeOne({ id: upload.id })

		return {
			newRev,
			newSnapshotUrl: this.snapshotUrl(meta.id, newRev),
			newEtag: etag,
		}
	}

	getSnapshot(id: string, rev: number): { etag: string; json: string } | null {
		const key = snapshotKey(id, rev)
		const doc = this.snapshots.findOne({ key })
		if (!doc) return null
		return { etag: doc.etag, json: doc.json }
	}

	async acceptUpload(params: { workbookId: string; uploadId: string; token: string; json: string }): Promise<{ ok: true }> {
		const upload = this.uploads.findOne({ id: params.uploadId })
		if (!upload || upload.workbookId !== params.workbookId) throw new Error('[univer] upload not found')
		if (upload.commitToken !== params.token) throw new Error('[univer] invalid token')
		if (Date.now() > upload.expiresAt) {
			this.uploads.removeOne({ id: upload.id })
			throw new Error('[univer] upload expired')
		}

		const size = Buffer.byteLength(params.json, 'utf8')
		if (size !== upload.expectedSize) throw new Error('[univer] upload size mismatch')
		const sha256 = sha256Hex(params.json)
		if (sha256 !== upload.expectedSha256) throw new Error('[univer] upload sha256 mismatch')

		this.uploads.updateOne(
			{ id: upload.id },
			{
				$set: {
					uploadedAt: Date.now(),
					uploadedJson: params.json,
					uploadedEtag: sha256,
					uploadedSize: size,
				},
			},
		)
		return { ok: true }
	}

	snapshotUrl(id: string, rev: number) {
		return `${API_PREFIX}/workbooks/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(String(rev))}`
	}

	private conflict(meta: WorkbookMetaDoc): UniverBeginSaveConflict | UniverCommitSaveConflict {
		return {
			conflict: true,
			currentRev: meta.latestRev,
			latestSnapshotUrl: meta.latestRev > 0 ? this.snapshotUrl(meta.id, meta.latestRev) : null,
			latestEtag: meta.latestEtag ?? null,
		}
	}

	private buildBreadcrumbs(folderId: string): UniverFolderMeta[] {
		const out: UniverFolderMeta[] = []
		const visited = new Set<string>()
		let curId: string | null = folderId
		while (curId) {
			if (visited.has(curId)) break
			visited.add(curId)
			const folder: FolderDoc | undefined = this.folders.findOne({ id: curId })
			if (!folder) break
			out.push(toFolderMeta(folder))
			curId = folder.parentId ?? null
		}
		out.reverse()
		return out
	}

	private collectFolderDescendants(rootId: string): string[] {
		const queue: string[] = [rootId]
		const out: string[] = []
		const visited = new Set<string>()
		while (queue.length) {
			const id = queue.shift()!
			if (visited.has(id)) continue
			visited.add(id)
			out.push(id)
			const children = this.folders.find({ parentId: id }).fetch()
			for (const c of children) queue.push(c.id)
		}
		return out
	}
}

function snapshotKey(id: string, rev: number) {
	return `${id}@${rev}`
}

function sha256Hex(text: string): string {
	return createHash('sha256').update(text).digest('hex')
}

export function formatEtag(etag: string) {
	return `"${etag}"`
}

export function normalizeEtag(value: string) {
	return value.trim().replace(/^W\//, '').replace(/^"|"$/g, '')
}

function normalizeFolderId(value: string | null | undefined): string | null {
	const v = typeof value === 'string' ? value.trim() : ''
	return v ? v : null
}

function toFolderMeta(doc: FolderDoc): UniverFolderMeta {
	return {
		id: doc.id,
		name: doc.name,
		parentId: doc.parentId ?? null,
		updatedAt: doc.updatedAt,
		createdAt: doc.createdAt,
	}
}

function toWorkbookMeta(doc: WorkbookMetaDoc): UniverWorkbookMeta {
	return {
		id: doc.id,
		name: doc.name,
		folderId: normalizeFolderId(doc.folderId),
		latestRev: doc.latestRev,
		latestEtag: doc.latestEtag ?? null,
		updatedAt: doc.updatedAt,
		createdAt: doc.createdAt,
	}
}
