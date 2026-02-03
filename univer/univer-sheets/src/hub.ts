import { BasePlugin, Plugin } from '@pluxel/hmr'
import { f, v } from '@pluxel/hmr/config'
import { RpcTarget } from '@pluxel/hmr/capnweb'
import { Collection } from '@pluxel/hmr/signaldb'

import type { SheetsPatchSpec, UniverContribution, UniverContributionInput } from './types'

type WorkbookSnapshot = import('@univerjs/core').IWorkbookData

type HmrServiceLike = { entries?: unknown }
type WithHmrConfig = { config: { hmrService?: HmrServiceLike } }

function shouldRegisterHmrExtensions(ctx: WithHmrConfig): boolean {
	const entries = ctx.config.hmrService?.entries
	return Array.isArray(entries) && entries.length > 0
}

export type StoredSnapshotFile = {
	version: 1
	docId: string
	savedAt: number
	snapshot: WorkbookSnapshot
}

type SnapshotMetaDoc = { id: string; savedAt: number; baseSeq: number }
type SnapshotDataDoc = { id: string; snapshot: WorkbookSnapshot }

type PatchMetaDoc = { id: string; lastSeq: number }
type PatchLogDoc = {
	id: string
	docId: string
	seq: number
	at: number
	patch: SheetsPatchSpec
	sourceId?: string
}

type DocMetaDoc = { id: string; createdAt: number; updatedAt: number; title?: string }
type FolderMetaDoc = { id: string; createdAt: number; updatedAt: number; title?: string }

export type UniverSheetsDocInfo = {
	docId: string
	title?: string
	createdAt: number
	updatedAt: number
	hasSnapshot: boolean
	savedAt: number | null
	baseSeq: number
	lastSeq: number
}

export type UniverSheetsFolderInfo = {
	folderId: string
	title?: string
	createdAt: number
	updatedAt: number
}

export type UniverSheetsTree = {
	prefix: string
	folders: UniverSheetsFolderInfo[]
	docs: UniverSheetsDocInfo[]
}

const SheetsHubPersistenceSchema = v.object({
	enabled: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({
			label: '持久化存储',
			description:
				'将工作簿 snapshot 持久化到 Pluxel 插件数据目录（由内核管理落盘），支持启动自动加载/自动保存（可关闭）。',
		}),
		f.booleanMeta({}),
	),
	storeId: v.pipe(
		v.optional(v.string(), 'pluxel'),
		v.minLength(1),
		f.formMeta({
			label: '存储后端',
			description: '默认 pluxel（内核提供的插件持久化）。未来可由其它插件提供（例如 ax / 数据库）。',
		}),
		f.stringMeta({ control: 'text' }),
	),
	docId: v.pipe(
		v.optional(v.string(), 'default'),
		v.minLength(1),
		f.formMeta({ label: '文档 ID', description: '用于区分不同工作簿存储（例如 default、demo/1 等）' }),
		f.stringMeta({ control: 'text' }),
	),
	autoLoadOnStart: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '启动时自动加载' }),
		f.booleanMeta({}),
	),
	autoSave: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '自动保存（基于命令执行 debounce）' }),
		f.booleanMeta({}),
	),
	autoSaveDebounceMs: v.pipe(
		v.optional(v.number(), 800),
		f.formMeta({ label: '自动保存 Debounce (ms)' }),
		f.numberMeta({ min: 100, max: 60_000, step: 50 }),
	),
})

const SheetsHubSettingsSchema = v.object({
	locale: v.pipe(
		v.optional(v.picklist(['zh-CN', 'en-US']), 'zh-CN'),
		f.formMeta({ label: '语言', description: 'Univer UI 的语言' }),
		f.picklistMeta({
			control: 'segmented',
			labels: { 'zh-CN': '中文', 'en-US': 'English' },
		}),
	),
	enableFilter: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '筛选 (Filter)' }),
		f.booleanMeta({}),
	),
	enableSort: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '排序 (Sort)' }),
		f.booleanMeta({}),
	),
	enableFindReplace: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '查找/替换 (Find & Replace)' }),
		f.booleanMeta({}),
	),
	enableNote: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '批注 (Note)' }),
		f.booleanMeta({}),
	),
	enableHyperLink: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '超链接 (Hyperlink)' }),
		f.booleanMeta({}),
	),
	enableDataValidation: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '数据验证 (Data Validation)' }),
		f.booleanMeta({}),
	),
	enableConditionalFormatting: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '条件格式 (Conditional Formatting)', description: '可选能力，默认关闭。' }),
		f.booleanMeta({}),
	),
	enableCrosshairHighlight: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '十字高亮 (Crosshair Highlight)' }),
		f.booleanMeta({}),
	),
	enableZenEditor: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '禅模式编辑 (Zen Editor)', description: '偏“沉浸式编辑”的可选能力，默认关闭。' }),
		f.booleanMeta({}),
	),
	enableUniscript: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({
			label: '脚本 (Uniscript)',
			description: '高级能力，默认关闭；建议仅在你确实需要脚本面板/自动化时开启。',
		}),
		f.booleanMeta({}),
	),
	enableTable: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '表格样式 (Table)', description: '可选能力，默认关闭。' }),
		f.booleanMeta({}),
	),
	enableDrawing: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '绘图 (Drawing)', description: '可选能力，默认关闭。' }),
		f.booleanMeta({}),
	),
	enableThreadComment: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '讨论串批注 (Thread Comment)', description: '可选能力，默认关闭。' }),
		f.booleanMeta({}),
	),
	persistence: v.optional(SheetsHubPersistenceSchema, {}),
})

export type SheetsHubSettings = v.InferOutput<typeof SheetsHubSettingsSchema>
export type SheetsHubPersistenceSettings = v.InferOutput<typeof SheetsHubPersistenceSchema>

type StoredContribution = {
	key: string
	sourcePlugin: string
	id: string
	getContribution: () => UniverContributionInput | null
	registeredAt: number
}

export type UniverSheetsSnapshotStore = {
	id: string
	listSnapshots(): Promise<Array<{ docId: string; savedAt: number }>>
	loadSnapshot(docId: string): Promise<StoredSnapshotFile | null>
	saveSnapshot(docId: string, snapshot: WorkbookSnapshot): Promise<{ savedAt: number }>
	deleteSnapshot(docId: string): Promise<void>
}

type StoredSnapshotStoreProvider = {
	key: string
	sourcePlugin: string
	id: string
	priority: number
	getStore: () => UniverSheetsSnapshotStore | null
	registeredAt: number
}

export type SheetsPatchEvent = {
	type: 'patch'
	docId: string
	seq: number
	at: number
	patch: SheetsPatchSpec
	sourceId?: string
}

export type SheetsPatchReadyEvent = {
	type: 'ready'
	docId: string
	lastSeq: number
}

function normalizeId(raw: string): string {
	const id = String(raw ?? '').trim()
	if (!id) throw new Error('[univer-sheets] contribution id must be non-empty')
	return id
}

function contributionKey(sourcePlugin: string, id: string): string {
	return `${sourcePlugin}:${id}`
}

function normalizeDocId(raw: string): string {
	const docId = String(raw ?? '').trim()
	if (!docId) throw new Error('[univer-sheets] docId must be non-empty')
	if (docId.length > 200) throw new Error('[univer-sheets] docId too long (max 200 chars)')
	if (docId.startsWith('/') || docId.endsWith('/'))
		throw new Error('[univer-sheets] docId must not start/end with "/"')
	if (docId.includes('\\')) throw new Error('[univer-sheets] docId must not contain "\\\\" (use "/" as separator)')
	const segments = docId.split('/')
	for (const s of segments) {
		if (!s) throw new Error('[univer-sheets] docId must not contain empty path segments')
		if (s === '.' || s === '..') throw new Error('[univer-sheets] docId must not contain "." or ".." segments')
	}
	return docId
}

function normalizeFolderId(raw: string): string {
	const folderId = String(raw ?? '').trim()
	if (!folderId) throw new Error('[univer-sheets] folderId must be non-empty')
	if (folderId.length > 200) throw new Error('[univer-sheets] folderId too long (max 200 chars)')
	if (folderId.startsWith('/') || folderId.endsWith('/'))
		throw new Error('[univer-sheets] folderId must not start/end with "/"')
	if (folderId.includes('\\'))
		throw new Error('[univer-sheets] folderId must not contain "\\\\" (use "/" as separator)')
	const segments = folderId.split('/')
	for (const s of segments) {
		if (!s) throw new Error('[univer-sheets] folderId must not contain empty path segments')
		if (s === '.' || s === '..') throw new Error('[univer-sheets] folderId must not contain "." or ".." segments')
	}
	return folderId
}

function normalizeTreePrefix(raw: string): string {
	const prefix = String(raw ?? '').trim()
	if (!prefix) return ''
	return normalizeFolderId(prefix)
}

function parentFoldersForDocId(docId: string): string[] {
	const normalized = normalizeDocId(docId)
	const parts = normalized.split('/')
	if (parts.length <= 1) return []
	const out: string[] = []
	for (let i = 1; i < parts.length; i++) {
		out.push(parts.slice(0, i).join('/'))
	}
	return out
}

function parentFolderOfDoc(docId: string): string {
	const normalized = normalizeDocId(docId)
	const idx = normalized.lastIndexOf('/')
	return idx >= 0 ? normalized.slice(0, idx) : ''
}

@Plugin({ name: 'UniverSheetsHub', type: 'service' })
export class UniverSheetsHub extends BasePlugin {
	// `configs.use(...)` provides validated runtime configs for this plugin.
	settings = this.configs.use(SheetsHubSettingsSchema)

	private readonly contributions = new Map<string, StoredContribution>()
	private readonly snapshotStoreProviders = new Map<string, StoredSnapshotStoreProvider>()

	private snapshotsMeta!: Collection<SnapshotMetaDoc>
	private snapshotsData!: Collection<SnapshotDataDoc>
	private patchesMeta!: Collection<PatchMetaDoc>
	private patchesLog!: Collection<PatchLogDoc>
	private docsMeta!: Collection<DocMetaDoc>
	private foldersMeta!: Collection<FolderMetaDoc>

	private readonly patchChannels = new Map<string, Set<import('@pluxel/hmr/services').SseChannel>>()
	private readonly patchQueueByDoc = new Map<string, Promise<void>>()

	private readonly pluxelStore: UniverSheetsSnapshotStore = {
		id: 'pluxel',
		listSnapshots: async () => this.listSnapshotsFromCollection(),
		loadSnapshot: async (docId) => this.loadSnapshotFromCollection(docId),
		saveSnapshot: async (docId, snapshot) => this.saveSnapshotToCollection(docId, snapshot),
		deleteSnapshot: async (docId) => this.deleteSnapshotFromCollection(docId),
	}

	override async init() {
		await this.initState()

		this.registerSnapshotStoreProvider(
			{
				id: this.pluxelStore.id,
				priority: 0,
				store: () => this.pluxelStore,
			},
			{ sourcePlugin: this.ctx.pluginInfo.id },
		)

		// Extension registration requires a real HMR host context (hmrService config with entries).
		// This keeps the core hub usable in tests/core runtime without importing HMR-only surfaces.
		if (shouldRegisterHmrExtensions(this.ctx)) {
			// `entryPath` is resolved relative to the plugin's runtime dir (usually the directory of the `@pluxel/hmr` entry).
			// This plugin entry is `./src/index.ts`, so the runtime dir is `src/`.
			this.ctx.ext.ui.register({ entryPath: './ui/index.tsx' })
			this.ctx.ext.rpc.registerExtension(() => new UniverSheetsHubRpc(this))
			this.ctx.ext.sse.registerExtension(() => this.attachSse())
		}
	}

	private async initState() {
		this.snapshotsMeta = new Collection<SnapshotMetaDoc, string, SnapshotMetaDoc>({
			name: 'univer-sheets.snapshots.meta',
			persistence: await this.ctx.pluginData.persistenceForCollection<SnapshotMetaDoc>(
				'univer-sheets.snapshots.meta',
			),
		})
		this.snapshotsData = new Collection<SnapshotDataDoc, string, SnapshotDataDoc>({
			name: 'univer-sheets.snapshots.data',
			persistence: await this.ctx.pluginData.persistenceForCollection<SnapshotDataDoc>(
				'univer-sheets.snapshots.data',
			),
		})

		this.patchesMeta = new Collection<PatchMetaDoc, string, PatchMetaDoc>({
			name: 'univer-sheets.patches.meta',
			persistence: await this.ctx.pluginData.persistenceForCollection<PatchMetaDoc>('univer-sheets.patches.meta'),
		})
		this.patchesLog = new Collection<PatchLogDoc, string, PatchLogDoc>({
			name: 'univer-sheets.patches.log',
			persistence: await this.ctx.pluginData.persistenceForCollection<PatchLogDoc>('univer-sheets.patches.log'),
		})

		this.docsMeta = new Collection<DocMetaDoc, string, DocMetaDoc>({
			name: 'univer-sheets.docs.meta',
			persistence: await this.ctx.pluginData.persistenceForCollection<DocMetaDoc>('univer-sheets.docs.meta'),
		})
		this.foldersMeta = new Collection<FolderMetaDoc, string, FolderMetaDoc>({
			name: 'univer-sheets.folders.meta',
			persistence: await this.ctx.pluginData.persistenceForCollection<FolderMetaDoc>('univer-sheets.folders.meta'),
		})

		// Enforce hub invariants for persisted state:
		// any doc that has a snapshot or patch metadata should have a doc meta record.
		for (const s of this.snapshotsMeta.find().fetch()) {
			this.ensureDocMeta(s.id)
		}
		for (const p of this.patchesMeta.find().fetch()) {
			this.ensureDocMeta(p.id)
		}
	}

	private ensureDocMeta(docId: string): DocMetaDoc {
		const normalized = normalizeDocId(docId)
		const existing = this.docsMeta.findOne({ id: normalized })
		if (existing) return existing
		const now = Date.now()
		const created: DocMetaDoc = { id: normalized, createdAt: now, updatedAt: now }
		this.docsMeta.insert(created)
		for (const folderId of parentFoldersForDocId(normalized)) {
			this.ensureFolderMeta(folderId)
		}
		return created
	}

	private touchDoc(docId: string, at = Date.now()) {
		const normalized = normalizeDocId(docId)
		this.ensureDocMeta(normalized)
		this.docsMeta.updateOne({ id: normalized }, { $set: { updatedAt: at } })
		for (const folderId of parentFoldersForDocId(normalized)) {
			this.touchFolder(folderId, at)
		}
	}

	private ensureFolderMeta(folderId: string): FolderMetaDoc {
		const normalized = normalizeFolderId(folderId)
		const existing = this.foldersMeta.findOne({ id: normalized })
		if (existing) return existing
		const now = Date.now()
		const created: FolderMetaDoc = { id: normalized, createdAt: now, updatedAt: now }
		this.foldersMeta.insert(created)
		const idx = normalized.lastIndexOf('/')
		if (idx >= 0) this.ensureFolderMeta(normalized.slice(0, idx))
		return created
	}

	private touchFolder(folderId: string, at = Date.now()) {
		const normalized = normalizeFolderId(folderId)
		this.ensureFolderMeta(normalized)
		this.foldersMeta.updateOne({ id: normalized }, { $set: { updatedAt: at } })
	}

	private resolveSnapshotStore(): UniverSheetsSnapshotStore {
		const persistence = this.settings.persistence
		const storeId = String(persistence.storeId ?? 'pluxel').trim() || 'pluxel'
		if (!persistence.enabled) throw new Error('[univer-sheets] persistence is disabled')

		// Prefer exact id match. If the id is unknown, fail fast to surface misconfiguration.
		let matched: StoredSnapshotStoreProvider | null = null
		for (const p of this.snapshotStoreProviders.values()) {
			if (p.id !== storeId) continue
			if (!matched) matched = p
			else if (
				p.priority > matched.priority ||
				(p.priority === matched.priority && p.registeredAt < matched.registeredAt)
			)
				matched = p
		}
		if (matched) {
			const store = matched.getStore()
			if (!store)
				throw new Error(
					`[univer-sheets] snapshot store unavailable: ${storeId} (from ${matched.sourcePlugin})`,
				)
			return store
		}
		if (storeId === this.pluxelStore.id) return this.pluxelStore
		throw new Error(`[univer-sheets] unknown snapshot storeId: ${storeId}`)
	}

	private loadSnapshotFromCollection(docId: string): StoredSnapshotFile | null {
		const normalized = normalizeDocId(docId)
		const data = this.snapshotsData.findOne({ id: normalized })
		if (!data) return null
		const meta = this.snapshotsMeta.findOne({ id: normalized })
		const savedAt = meta?.savedAt ?? 0
		return {
			version: 1,
			docId: normalized,
			savedAt,
			snapshot: data.snapshot,
		}
	}

	private async saveSnapshotToCollection(docId: string, snapshot: WorkbookSnapshot): Promise<{ savedAt: number }> {
		const normalized = normalizeDocId(docId)
		this.touchDoc(normalized)
		const savedAt = Date.now()
		const existingData = this.snapshotsData.findOne({ id: normalized })
		if (!existingData) this.snapshotsData.insert({ id: normalized, snapshot })
		else this.snapshotsData.updateOne({ id: normalized }, { $set: { snapshot } })

		const existingMeta = this.snapshotsMeta.findOne({ id: normalized })
		const baseSeq = this.ensurePatchMeta(normalized).lastSeq ?? 0
		if (!existingMeta) this.snapshotsMeta.insert({ id: normalized, savedAt, baseSeq })
		else this.snapshotsMeta.updateOne({ id: normalized }, { $set: { savedAt, baseSeq } })

		await this.prunePatchesUpTo(normalized, baseSeq)
		return { savedAt }
	}

	private async deleteSnapshotFromCollection(docId: string): Promise<void> {
		const normalized = normalizeDocId(docId)
		this.snapshotsMeta.removeOne({ id: normalized })
		this.snapshotsData.removeOne({ id: normalized })
	}

	private async listSnapshotsFromCollection(): Promise<Array<{ docId: string; savedAt: number }>> {
		const list = this.snapshotsMeta
			.find()
			.fetch()
			.map((d) => ({ docId: d.id, savedAt: d.savedAt }))
		return list.sort((a, b) => b.savedAt - a.savedAt || a.docId.localeCompare(b.docId))
	}

	getSnapshotBaseSeq(docId: string): number {
		const normalized = normalizeDocId(docId)
		const raw = this.snapshotsMeta.findOne({ id: normalized })?.baseSeq
		const base = typeof raw === 'number' ? raw : Number.NaN
		return Number.isFinite(base) ? Math.max(0, Math.floor(base)) : 0
	}

	getLastPatchSeq(docId: string): number {
		const normalized = normalizeDocId(docId)
		const last = this.ensurePatchMeta(normalized).lastSeq
		return Number.isFinite(last) ? Math.max(0, Math.floor(last)) : 0
	}

	listDocs(): UniverSheetsDocInfo[] {
		const docs = this.docsMeta.find().fetch()
		const snapshots = this.snapshotsMeta.find().fetch()
		const patches = this.patchesMeta.find().fetch()

		const snapshotById = new Map<string, SnapshotMetaDoc>()
		for (const s of snapshots) snapshotById.set(s.id, s)

		const patchById = new Map<string, PatchMetaDoc>()
		for (const p of patches) patchById.set(p.id, p)

		const list: UniverSheetsDocInfo[] = []
		for (const d of docs) {
			const snapshot = snapshotById.get(d.id)
			const patch = patchById.get(d.id)
			list.push({
				docId: d.id,
				title: d.title,
				createdAt: d.createdAt,
				updatedAt: d.updatedAt,
				hasSnapshot: !!snapshot,
				savedAt: snapshot ? snapshot.savedAt : null,
				baseSeq: snapshot ? snapshot.baseSeq : 0,
				lastSeq: patch ? patch.lastSeq : 0,
			})
		}

		return list.sort((a, b) => {
			const as = a.savedAt ?? -1
			const bs = b.savedAt ?? -1
			if (as !== bs) return bs - as
			if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
			if (a.lastSeq !== b.lastSeq) return b.lastSeq - a.lastSeq
			return a.docId.localeCompare(b.docId)
		})
	}

	listFolders(): UniverSheetsFolderInfo[] {
		const list = this.foldersMeta
			.find()
			.fetch()
			.map((f) => ({ folderId: f.id, title: f.title, createdAt: f.createdAt, updatedAt: f.updatedAt }))
		return list.sort((a, b) => b.updatedAt - a.updatedAt || a.folderId.localeCompare(b.folderId))
	}

	tree(prefixRaw?: string): UniverSheetsTree {
		const prefix = normalizeTreePrefix(prefixRaw ?? '')

		const docs = this.listDocs()
		const folders = this.listFolders()

		const childFolderById = new Map<string, UniverSheetsFolderInfo>()

		for (const f of folders) {
			if (prefix && !f.folderId.startsWith(`${prefix}/`)) continue
			if (!prefix && !f.folderId.includes('/')) {
				childFolderById.set(f.folderId, f)
				continue
			}

			const rest = prefix ? f.folderId.slice(prefix.length + 1) : f.folderId
			if (!rest) continue
			const seg = rest.split('/')[0] ?? ''
			if (!seg) continue
			const childId = prefix ? `${prefix}/${seg}` : seg
			if (childId === f.folderId) childFolderById.set(childId, f)
		}

		for (const d of docs) {
			if (prefix && !d.docId.startsWith(`${prefix}/`)) continue
			const rest = prefix ? d.docId.slice(prefix.length + 1) : d.docId
			if (!rest) continue
			const seg = rest.split('/')[0] ?? ''
			if (!seg) continue
			if (!rest.includes('/')) continue
			const childId = prefix ? `${prefix}/${seg}` : seg
			if (childFolderById.has(childId)) continue
			const meta = this.foldersMeta.findOne({ id: childId })
			if (meta) {
				childFolderById.set(childId, {
					folderId: meta.id,
					title: meta.title,
					createdAt: meta.createdAt,
					updatedAt: meta.updatedAt,
				})
			} else {
				const now = Date.now()
				childFolderById.set(childId, { folderId: childId, createdAt: now, updatedAt: now })
			}
		}

		const childDocs = docs.filter((d) => parentFolderOfDoc(d.docId) === prefix).sort((a, b) => a.docId.localeCompare(b.docId))

		return {
			prefix,
			folders: Array.from(childFolderById.values()).sort((a, b) => a.folderId.localeCompare(b.folderId)),
			docs: childDocs,
		}
	}

	async docBootstrap(
		docId: string,
		opts?: { afterSeq?: number; limit?: number },
	): Promise<{ snapshot: StoredSnapshotFile | null; baseSeq: number; lastSeq: number; patches: PatchLogDoc[] }> {
		const normalized = normalizeDocId(docId)
		this.ensureDocMeta(normalized)
		const snapshotEnabled = !!this.settings.persistence.enabled
		const baseSeq = snapshotEnabled ? this.getSnapshotBaseSeq(normalized) : 0
		const lastSeq = this.getLastPatchSeq(normalized)
		const after = Math.max(baseSeq, Math.floor(Number(opts?.afterSeq) || 0))
		const snapshot = snapshotEnabled ? await this.loadSnapshot(normalized) : null
		const patches = await this.patchesSince(normalized, after, opts?.limit)
		return { snapshot, baseSeq, lastSeq, patches }
	}

	private withPatchQueue<T>(docId: string, runner: () => Promise<T>): Promise<T> {
		const normalized = normalizeDocId(docId)
		const prev = this.patchQueueByDoc.get(normalized) ?? Promise.resolve()
		let release!: () => void
		const current = new Promise<void>((r) => {
			release = r
		})
		const tail = prev.then(() => current)
		this.patchQueueByDoc.set(normalized, tail)

		return prev
			.then(runner)
			.finally(() => {
				release()
				if (this.patchQueueByDoc.get(normalized) === tail) this.patchQueueByDoc.delete(normalized)
			})
	}

	private ensurePatchMeta(docId: string): PatchMetaDoc {
		const normalized = normalizeDocId(docId)
		this.ensureDocMeta(normalized)
		const existing = this.patchesMeta.findOne({ id: normalized })
		if (existing) return existing
		const created: PatchMetaDoc = { id: normalized, lastSeq: 0 }
		this.patchesMeta.insert(created)
		return created
	}

	private patchLogId(docId: string, seq: number): string {
		return `${docId}:${seq}`
	}

	async appendPatch(docId: string, patch: SheetsPatchSpec, opts?: { sourceId?: string }): Promise<SheetsPatchEvent> {
		return this.withPatchQueue(docId, async () => {
			const normalized = normalizeDocId(docId)
			this.touchDoc(normalized)
			const meta = this.ensurePatchMeta(normalized)
			const nextSeq = (Number.isFinite(meta.lastSeq) ? meta.lastSeq : 0) + 1
			const at = Date.now()

			this.patchesMeta.updateOne({ id: normalized }, { $set: { lastSeq: nextSeq } })
			const entry: PatchLogDoc = {
				id: this.patchLogId(normalized, nextSeq),
				docId: normalized,
				seq: nextSeq,
				at,
				patch,
				sourceId: opts?.sourceId,
			}
			this.patchesLog.insert(entry)

			const event: SheetsPatchEvent = {
				type: 'patch',
				docId: normalized,
				seq: nextSeq,
				at,
				patch,
				sourceId: opts?.sourceId,
			}
			this.broadcastPatch(event)
			return event
		})
	}

	async patchesSince(docId: string, afterSeq = 0, limit = 200): Promise<PatchLogDoc[]> {
		const normalized = normalizeDocId(docId)
		const after = Math.max(0, Math.floor(Number(afterSeq) || 0))
		const capped = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)))

		const list = this.patchesLog
			.find({ docId: normalized })
			.fetch()
			.filter((p) => p.seq > after)
			.sort((a, b) => a.seq - b.seq)
			.slice(0, capped)
		return list
	}

	createDoc(docId: string, opts?: { title?: string }): UniverSheetsDocInfo {
		const normalized = normalizeDocId(docId)
		const now = Date.now()
		const existing = this.docsMeta.findOne({ id: normalized })
		const title = typeof opts?.title === 'string' ? opts.title.trim() : ''
		if (existing) {
			if (title && existing.title !== title) {
				this.docsMeta.updateOne({ id: normalized }, { $set: { title, updatedAt: now } })
			}
			return this.ensureDocInfo(normalized)
		}

		this.docsMeta.insert({
			id: normalized,
			createdAt: now,
			updatedAt: now,
			...(title ? { title } : {}),
		})
		for (const folderId of parentFoldersForDocId(normalized)) {
			this.touchFolder(folderId, now)
		}
		return this.ensureDocInfo(normalized)
	}

	private ensureDocInfo(docId: string): UniverSheetsDocInfo {
		const normalized = normalizeDocId(docId)
		const meta = this.ensureDocMeta(normalized)
		const snapshot = this.snapshotsMeta.findOne({ id: normalized })
		const patch = this.patchesMeta.findOne({ id: normalized })
		return {
			docId: normalized,
			title: meta.title,
			createdAt: meta.createdAt,
			updatedAt: meta.updatedAt,
			hasSnapshot: !!snapshot,
			savedAt: snapshot ? snapshot.savedAt : null,
			baseSeq: snapshot ? snapshot.baseSeq : 0,
			lastSeq: patch ? patch.lastSeq : 0,
		}
	}

	async deleteDoc(docId: string): Promise<void> {
		const normalized = normalizeDocId(docId)
		await this.withPatchQueue(normalized, async () => {
			// Until snapshot blob store is decoupled from meta, structural ops require pluxel store.
			if (this.settings.persistence.enabled && this.settings.persistence.storeId !== 'pluxel') {
				throw new Error('[univer-sheets] deleteDoc requires storeId=pluxel (snapshot store may be external)')
			}

			this.snapshotsMeta.removeOne({ id: normalized })
			this.snapshotsData.removeOne({ id: normalized })

			this.patchesMeta.removeOne({ id: normalized })
			for (const d of this.patchesLog.find({ docId: normalized }).fetch()) {
				this.patchesLog.removeOne({ id: d.id })
			}

			this.docsMeta.removeOne({ id: normalized })
		})
	}

	async renameDoc(fromDocId: string, toDocId: string): Promise<void> {
		const from = normalizeDocId(fromDocId)
		const to = normalizeDocId(toDocId)
		if (from === to) return

		if (this.settings.persistence.enabled && this.settings.persistence.storeId !== 'pluxel') {
			throw new Error('[univer-sheets] renameDoc requires storeId=pluxel (snapshot store may be external)')
		}

		await this.withPatchQueue(from, async () => {
			await this.withPatchQueue(to, async () => {
				if (this.docsMeta.findOne({ id: to })) throw new Error(`[univer-sheets] doc already exists: ${to}`)
				if (this.snapshotsMeta.findOne({ id: to }) || this.snapshotsData.findOne({ id: to }))
					throw new Error(`[univer-sheets] snapshot already exists for: ${to}`)
				if (this.patchesMeta.findOne({ id: to }) || this.patchesLog.find({ docId: to }).count() > 0)
					throw new Error(`[univer-sheets] patch log already exists for: ${to}`)

				const now = Date.now()
				const fromMeta = this.docsMeta.findOne({ id: from }) ?? this.ensureDocMeta(from)
				this.docsMeta.insert({
					id: to,
					createdAt: fromMeta.createdAt,
					updatedAt: now,
					...(fromMeta.title ? { title: fromMeta.title } : {}),
				})
				this.docsMeta.removeOne({ id: from })

				for (const folderId of parentFoldersForDocId(to)) {
					this.touchFolder(folderId, now)
				}

				const snapshotMeta = this.snapshotsMeta.findOne({ id: from })
				if (snapshotMeta) {
					this.snapshotsMeta.insert({ ...snapshotMeta, id: to })
					this.snapshotsMeta.removeOne({ id: from })
				}
				const snapshotData = this.snapshotsData.findOne({ id: from })
				if (snapshotData) {
					this.snapshotsData.insert({ ...snapshotData, id: to })
					this.snapshotsData.removeOne({ id: from })
				}

				const patchMeta = this.patchesMeta.findOne({ id: from })
				if (patchMeta) {
					this.patchesMeta.insert({ ...patchMeta, id: to })
					this.patchesMeta.removeOne({ id: from })
				}

				const logs = this.patchesLog.find({ docId: from }).fetch().sort((a, b) => a.seq - b.seq)
				for (const entry of logs) {
					this.patchesLog.insert({ ...entry, id: this.patchLogId(to, entry.seq), docId: to })
					this.patchesLog.removeOne({ id: entry.id })
				}
			})
		})
	}

	createFolder(folderId: string, opts?: { title?: string }): UniverSheetsFolderInfo {
		const normalized = normalizeFolderId(folderId)
		const now = Date.now()
		const existing = this.foldersMeta.findOne({ id: normalized })
		const title = typeof opts?.title === 'string' ? opts.title.trim() : ''

		if (!existing) {
			this.ensureFolderMeta(normalized)
			if (title) this.foldersMeta.updateOne({ id: normalized }, { $set: { title, updatedAt: now } })
			const meta = this.foldersMeta.findOne({ id: normalized })!
			return { folderId: meta.id, title: meta.title, createdAt: meta.createdAt, updatedAt: meta.updatedAt }
		}

		if (title && existing.title !== title) {
			this.foldersMeta.updateOne({ id: normalized }, { $set: { title, updatedAt: now } })
			return { folderId: normalized, title, createdAt: existing.createdAt, updatedAt: now }
		}

		return {
			folderId: normalized,
			title: existing.title,
			createdAt: existing.createdAt,
			updatedAt: existing.updatedAt,
		}
	}

	async deleteFolder(folderId: string, opts?: { recursive?: boolean }): Promise<void> {
		const normalized = normalizeFolderId(folderId)
		const recursive = !!opts?.recursive
		const prefix = `${normalized}/`

		const docs = this.docsMeta
			.find()
			.fetch()
			.filter((d) => d.id.startsWith(prefix))
			.map((d) => d.id)
		const folders = this.foldersMeta
			.find()
			.fetch()
			.filter((f) => f.id === normalized || f.id.startsWith(prefix))
			.map((f) => f.id)

		if (!recursive) {
			if (docs.length > 0) throw new Error(`[univer-sheets] folder not empty: ${normalized}`)
			const hasSubfolders = folders.some((f) => f !== normalized)
			if (hasSubfolders) throw new Error(`[univer-sheets] folder has subfolders: ${normalized}`)
			this.foldersMeta.removeOne({ id: normalized })
			return
		}

		for (const doc of docs.sort((a, b) => a.localeCompare(b))) {
			await this.deleteDoc(doc)
		}

		for (const f of folders.sort((a, b) => b.length - a.length)) {
			this.foldersMeta.removeOne({ id: f })
		}
	}

	async renameFolder(fromFolderId: string, toFolderId: string): Promise<void> {
		const from = normalizeFolderId(fromFolderId)
		const to = normalizeFolderId(toFolderId)
		if (from === to) return

		const fromPrefix = `${from}/`
		const toPrefix = `${to}/`

		const allDocs = this.docsMeta.find().fetch().map((d) => d.id)
		const allFolders = this.foldersMeta.find().fetch().map((f) => f.id)

		const hasFrom =
			allFolders.includes(from) || allFolders.some((f) => f.startsWith(fromPrefix)) || allDocs.some((d) => d.startsWith(fromPrefix))
		if (!hasFrom) throw new Error(`[univer-sheets] folder not found: ${from}`)

		const toCollides =
			allFolders.includes(to) ||
			allFolders.some((f) => f.startsWith(toPrefix)) ||
			allDocs.some((d) => d.startsWith(toPrefix))
		if (toCollides) throw new Error(`[univer-sheets] target folder not empty or already exists: ${to}`)

		const now = Date.now()

		// Rename folder metas first (deep -> shallow) to preserve titles and avoid implicit creation conflicts.
		const folders = allFolders
			.filter((f) => f === from || f.startsWith(fromPrefix))
			.sort((a, b) => b.length - a.length)
		for (const id of folders) {
			const next = id === from ? to : `${toPrefix}${id.slice(fromPrefix.length)}`
			const meta = this.foldersMeta.findOne({ id })
			if (!meta) continue
			this.foldersMeta.insert({ ...meta, id: next, updatedAt: now })
			this.foldersMeta.removeOne({ id })
		}

		// Rename docs under the folder.
		const docs = allDocs.filter((d) => d.startsWith(fromPrefix)).sort((a, b) => a.localeCompare(b))
		for (const docId of docs) {
			const next = `${toPrefix}${docId.slice(fromPrefix.length)}`
			await this.renameDoc(docId, next)
		}
	}

	private async prunePatchesUpTo(docId: string, baseSeq: number, keepTail = 50): Promise<void> {
		const normalized = normalizeDocId(docId)
		const base = Math.max(0, Math.floor(Number(baseSeq) || 0))
		const keep = Math.max(0, Math.floor(Number(keepTail) || 0))
		const pruneBelow = Math.max(0, base - keep)
		if (pruneBelow <= 0) return

		// SignalDB collections don't provide an indexed range delete API; keep this rare and explicit (snapshot save only).
		const docs = this.patchesLog.find({ docId: normalized }).fetch()
		for (const d of docs) {
			if ((d.seq ?? 0) > pruneBelow) continue
			this.patchesLog.removeOne({ id: d.id })
		}
	}

	private attachSse() {
		return (channel: import('@pluxel/hmr/services').SseChannel) => {
			const docId = String(channel.query.get('docId') ?? '').trim()
			if (!docId) {
				channel.emit('error', { type: 'error', message: '[univer-sheets] missing docId query param' })
				return
			}

			const normalized = normalizeDocId(docId)
			let set = this.patchChannels.get(normalized)
			if (!set) {
				set = new Set()
				this.patchChannels.set(normalized, set)
			}
			set.add(channel)

			const meta = this.ensurePatchMeta(normalized)
			const ready: SheetsPatchReadyEvent = { type: 'ready', docId: normalized, lastSeq: meta.lastSeq ?? 0 }
			channel.emit('ready', ready, { id: String(ready.lastSeq) })

			channel.onAbort(() => {
				const bucket = this.patchChannels.get(normalized)
				if (!bucket) return
				bucket.delete(channel)
				if (bucket.size === 0) this.patchChannels.delete(normalized)
			})

			return () => {
				const bucket = this.patchChannels.get(normalized)
				if (!bucket) return
				bucket.delete(channel)
				if (bucket.size === 0) this.patchChannels.delete(normalized)
			}
		}
	}

	private broadcastPatch(event: SheetsPatchEvent) {
		const bucket = this.patchChannels.get(event.docId)
		if (!bucket?.size) return
		for (const ch of bucket) {
			try {
				ch.emit('patch', event, { id: String(event.seq) })
			} catch (error) {
				this.ctx.logger.warn('failed to push Univer patch SSE', { error, docId: event.docId })
			}
		}
	}

	registerContribution(contribution: UniverContribution, opts: { sourcePlugin: string }): () => void {
		const { id, ...rest } = contribution
		return this.registerContributionProvider({ id, contribution: () => rest }, opts)
	}

	/**
	 * Register a dynamic contribution provider.
	 *
	 * This enables config-driven contributions without requiring plugin restarts:
	 * - Host plugin (this hub) resolves providers on demand (e.g. UI reload).
	 * - Source plugins can read current validated config inside the provider.
	 */
	registerContributionProvider(
		input: { id: string; contribution: () => UniverContributionInput | null },
		opts: { sourcePlugin: string },
	): () => void {
		const sourcePlugin = opts.sourcePlugin
		const id = normalizeId(input.id)
		const key = contributionKey(sourcePlugin, id)

		const stored: StoredContribution = {
			key,
			sourcePlugin,
			id,
			getContribution: input.contribution,
			registeredAt: Date.now(),
		}
		this.contributions.set(key, stored)

		return () => {
			this.contributions.delete(key)
		}
	}

	registerSnapshotStoreProvider(
		input: { id: string; priority?: number; store: () => UniverSheetsSnapshotStore | null },
		opts: { sourcePlugin: string },
	): () => void {
		const sourcePlugin = opts.sourcePlugin
		const id = normalizeId(input.id)
		for (const existing of this.snapshotStoreProviders.values()) {
			if (existing.id === id) {
				throw new Error(
					`[univer-sheets] snapshot storeId already registered: ${id} (from ${existing.sourcePlugin})`,
				)
			}
		}
		const key = contributionKey(sourcePlugin, id)
		const priority = Number.isFinite(input.priority) ? Number(input.priority) : 0

		const stored: StoredSnapshotStoreProvider = {
			key,
			sourcePlugin,
			id,
			priority,
			getStore: input.store,
			registeredAt: Date.now(),
		}
		this.snapshotStoreProviders.set(key, stored)

		return () => {
			this.snapshotStoreProviders.delete(key)
		}
	}

	async loadSnapshot(docId: string): Promise<StoredSnapshotFile | null> {
		return this.resolveSnapshotStore().loadSnapshot(docId)
	}

	async saveSnapshot(docId: string, snapshot: WorkbookSnapshot): Promise<{ savedAt: number }> {
		return this.resolveSnapshotStore().saveSnapshot(docId, snapshot)
	}

	async deleteSnapshot(docId: string): Promise<void> {
		return this.resolveSnapshotStore().deleteSnapshot(docId)
	}

	async listSnapshots(): Promise<Array<{ docId: string; savedAt: number }>> {
		return this.resolveSnapshotStore().listSnapshots()
	}

	listContributions(): Array<{
		sourcePlugin: string
		contribution: UniverContribution
		registeredAt: number
	}> {
		const resolved: Array<{
			sourcePlugin: string
			contribution: UniverContribution
			registeredAt: number
		}> = []

		for (const item of this.contributions.values()) {
			let raw: UniverContributionInput | null
			try {
				raw = item.getContribution()
			} catch (error) {
				this.ctx.logger.warn('failed to resolve Univer contribution', {
					error,
					sourcePlugin: item.sourcePlugin,
					id: item.id,
				})
				continue
			}
			if (!raw) continue
			resolved.push({
				sourcePlugin: item.sourcePlugin,
				contribution: { ...raw, id: item.id },
				registeredAt: item.registeredAt,
			})
		}

		return resolved.sort((a, b) => {
			const ap = a.contribution.priority ?? 0
			const bp = b.contribution.priority ?? 0
			if (ap !== bp) return bp - ap
			if (a.sourcePlugin !== b.sourcePlugin) return a.sourcePlugin.localeCompare(b.sourcePlugin)
			if (a.contribution.id !== b.contribution.id) return a.contribution.id.localeCompare(b.contribution.id)
			return a.registeredAt - b.registeredAt
		})
	}
}

export class UniverSheetsHubRpc extends RpcTarget {
	constructor(private readonly hub: UniverSheetsHub) {
		super()
	}

	bootstrap(): Promise<{
		settings: SheetsHubSettings
		contributions: Array<{
			sourcePlugin: string
			contribution: UniverContribution
			registeredAt: number
		}>
	}> {
		return Promise.resolve({
			settings: this.hub.settings,
			contributions: this.hub.listContributions(),
		})
	}

	settings(): Promise<SheetsHubSettings> {
		return Promise.resolve(this.hub.settings)
	}

	docs(): Promise<UniverSheetsDocInfo[]> {
		return Promise.resolve(this.hub.listDocs())
	}

	folders(): Promise<UniverSheetsFolderInfo[]> {
		return Promise.resolve(this.hub.listFolders())
	}

	tree(prefix?: string): Promise<UniverSheetsTree> {
		return Promise.resolve(this.hub.tree(prefix))
	}

	createDoc(docId: string, opts?: { title?: string }): Promise<UniverSheetsDocInfo> {
		return Promise.resolve(this.hub.createDoc(docId, opts))
	}

	deleteDoc(docId: string): Promise<void> {
		return this.hub.deleteDoc(docId)
	}

	renameDoc(fromDocId: string, toDocId: string): Promise<void> {
		return this.hub.renameDoc(fromDocId, toDocId)
	}

	createFolder(folderId: string, opts?: { title?: string }): Promise<UniverSheetsFolderInfo> {
		return Promise.resolve(this.hub.createFolder(folderId, opts))
	}

	deleteFolder(folderId: string, opts?: { recursive?: boolean }): Promise<void> {
		return this.hub.deleteFolder(folderId, opts)
	}

	renameFolder(fromFolderId: string, toFolderId: string): Promise<void> {
		return this.hub.renameFolder(fromFolderId, toFolderId)
	}

	snapshots(): Promise<Array<{ docId: string; savedAt: number }>> {
		return this.hub.listSnapshots()
	}

	loadSnapshot(docId: string): Promise<StoredSnapshotFile | null> {
		return this.hub.loadSnapshot(docId)
	}

	saveSnapshot(docId: string, snapshot: WorkbookSnapshot): Promise<{ savedAt: number }> {
		return this.hub.saveSnapshot(docId, snapshot)
	}

	deleteSnapshot(docId: string): Promise<void> {
		return this.hub.deleteSnapshot(docId)
	}

	appendPatch(docId: string, patch: SheetsPatchSpec, opts?: { sourceId?: string }): Promise<SheetsPatchEvent> {
		return this.hub.appendPatch(docId, patch, opts)
	}

	patchesSince(docId: string, afterSeq?: number, limit?: number): Promise<PatchLogDoc[]> {
		return this.hub.patchesSince(docId, afterSeq, limit)
	}

	docBootstrap(
		docId: string,
		afterSeq?: number,
		limit?: number,
	): Promise<{ snapshot: StoredSnapshotFile | null; baseSeq: number; lastSeq: number; patches: PatchLogDoc[] }> {
		return this.hub.docBootstrap(docId, { afterSeq, limit })
	}

	contributions(): Promise<
		Array<{
			sourcePlugin: string
			contribution: UniverContribution
			registeredAt: number
		}>
	> {
		return Promise.resolve(this.hub.listContributions())
	}
}

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			UniverSheetsHub: UniverSheetsHubRpc
		}
		interface sse {
			UniverSheetsHub: SheetsPatchEvent | SheetsPatchReadyEvent | { type: 'error'; message: string }
		}
	}
}
