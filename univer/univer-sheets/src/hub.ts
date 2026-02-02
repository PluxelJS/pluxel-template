import { BasePlugin, Plugin } from '@pluxel/hmr'
import { f, v } from '@pluxel/hmr/config'
import { RpcTarget } from '@pluxel/hmr/capnweb'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { UniverContribution, UniverContributionInput } from './types'

type WorkbookSnapshot = import('@univerjs/core').IWorkbookData

type StoredSnapshotFile = {
	version: 1
	docId: string
	savedAt: number
	snapshot: WorkbookSnapshot
}

const SheetsHubPersistenceSchema = v.object({
	enabled: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({
			label: '持久化存储',
			description: '将工作簿 snapshot 存到宿主磁盘，支持启动自动加载/自动保存（可关闭）。',
		}),
		f.booleanMeta({}),
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
	storageDir: v.pipe(
		v.optional(v.string(), '.pluxel/univer-sheets'),
		v.minLength(1),
		f.formMeta({
			label: '存储目录',
			description: '默认写入 .pluxel/univer-sheets（不进 git）；可改为绝对路径或自定义相对路径。',
		}),
		f.stringMeta({ control: 'text' }),
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
		f.formMeta({ label: '条件格式 (Conditional Formatting)' }),
		f.booleanMeta({}),
	),
	enableCrosshairHighlight: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '十字高亮 (Crosshair Highlight)' }),
		f.booleanMeta({}),
	),
	enableZenEditor: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '禅模式编辑 (Zen Editor)' }),
		f.booleanMeta({}),
	),
	enableUniscript: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '脚本 (Uniscript)' }),
		f.booleanMeta({}),
	),
	enableTable: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '表格样式 (Table)' }),
		f.booleanMeta({}),
	),
	enableDrawing: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '绘图 (Drawing)' }),
		f.booleanMeta({}),
	),
	enableThreadComment: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '讨论串批注 (Thread Comment)' }),
		f.booleanMeta({}),
	),
	persistence: SheetsHubPersistenceSchema,
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
	return docId
}

function safeFileNameForDocId(docId: string): string {
	// `encodeURIComponent` is path-safe (no slashes) and reversible (for listing).
	return encodeURIComponent(docId)
}

function tryDecodeDocIdFromFileName(fileName: string): string | null {
	try {
		if (!fileName.endsWith('.json')) return null
		const raw = fileName.slice(0, -'.json'.length)
		return decodeURIComponent(raw)
	} catch {
		return null
	}
}

@Plugin({ name: 'UniverSheetsHub', type: 'service' })
export class UniverSheetsHub extends BasePlugin {
	// NOTE: This is injected once on plugin start (for UI schema exposure). For live reads, prefer ConfigService.
	settings = this.configs.use(SheetsHubSettingsSchema)

	private readonly contributions = new Map<string, StoredContribution>()

	override async init() {
		// `entryPath` is resolved relative to the plugin's runtime dir (usually the directory of the `@pluxel/hmr` entry).
		// This plugin entry is `./src/index.ts`, so the runtime dir is `src/`.
		this.ctx.ext.ui.register({ entryPath: './ui/index.tsx' })
		this.ctx.ext.rpc.registerExtension(() => new UniverSheetsHubRpc(this))
	}

	private resolveStoreDir(): string {
		const { storageDir } = this.settings.persistence
		const raw = String(storageDir ?? '').trim()
		if (!raw) return path.join(process.cwd(), '.pluxel/univer-sheets')
		return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw)
	}

	private snapshotDir(): string {
		return path.join(this.resolveStoreDir(), 'snapshots')
	}

	private snapshotFilePath(docId: string): { docId: string; filePath: string } {
		const normalized = normalizeDocId(docId)
		const fileName = `${safeFileNameForDocId(normalized)}.json`
		return { docId: normalized, filePath: path.join(this.snapshotDir(), fileName) }
	}

	async loadSnapshot(docId: string): Promise<StoredSnapshotFile | null> {
		const { filePath } = this.snapshotFilePath(docId)
		try {
			const raw = await readFile(filePath, 'utf8')
			const parsed = JSON.parse(raw) as Partial<StoredSnapshotFile> | null
			if (!parsed || typeof parsed !== 'object') return null
			if (parsed.version !== 1) return null
			if (!parsed.snapshot || typeof parsed.savedAt !== 'number' || typeof parsed.docId !== 'string') return null
			return parsed as StoredSnapshotFile
		} catch (error: any) {
			if (error?.code === 'ENOENT') return null
			throw error
		}
	}

	async saveSnapshot(docId: string, snapshot: WorkbookSnapshot): Promise<{ savedAt: number }> {
		const { docId: normalized, filePath } = this.snapshotFilePath(docId)
		await mkdir(this.snapshotDir(), { recursive: true })

		const savedAt = Date.now()
		const content: StoredSnapshotFile = { version: 1, docId: normalized, savedAt, snapshot }
		const json = JSON.stringify(content)

		const dir = path.dirname(filePath)
		const base = path.basename(filePath)
		const tmpPath = path.join(dir, `${base}.tmp-${savedAt}-${Math.random().toString(16).slice(2)}`)
		await writeFile(tmpPath, json, 'utf8')
		await rename(tmpPath, filePath)
		return { savedAt }
	}

	async deleteSnapshot(docId: string): Promise<void> {
		const { filePath } = this.snapshotFilePath(docId)
		try {
			await rm(filePath)
		} catch (error: any) {
			if (error?.code === 'ENOENT') return
			throw error
		}
	}

	async listSnapshots(): Promise<Array<{ docId: string; savedAt: number }>> {
		await mkdir(this.snapshotDir(), { recursive: true })
		const entries = await readdir(this.snapshotDir())
		const list: Array<{ docId: string; savedAt: number }> = []

		for (const fileName of entries) {
			const docId = tryDecodeDocIdFromFileName(fileName)
			if (!docId) continue
			try {
				const filePath = path.join(this.snapshotDir(), fileName)
				const raw = await readFile(filePath, 'utf8')
				const parsed = JSON.parse(raw) as Partial<StoredSnapshotFile> | null
				if (!parsed || parsed.version !== 1) continue
				if (typeof parsed.savedAt !== 'number') continue
				list.push({ docId, savedAt: parsed.savedAt })
			} catch (error) {
				this.ctx.logger.warn('failed to read Univer snapshot file', { error, fileName })
			}
		}

		return list.sort((a, b) => b.savedAt - a.savedAt || a.docId.localeCompare(b.docId))
	}

	registerContribution(contribution: UniverContribution, opts?: { sourcePlugin?: string }): () => void {
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
		opts?: { sourcePlugin?: string },
	): () => void {
		const sourcePlugin = opts?.sourcePlugin ?? this.ctx.caller?.pluginInfo?.id ?? '<unknown>'
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

	settings(): Promise<SheetsHubSettings> {
		return Promise.resolve(this.hub.settings)
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
	}
}
