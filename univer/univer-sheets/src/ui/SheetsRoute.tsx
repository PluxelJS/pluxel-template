import { useExtensionContext } from '@pluxel/hmr/web'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { applyTextWatermark, createSheetsUniver, type SheetsUniverApi } from './kit'

import type { SheetsHubSettings, UniverSheetsDocInfo } from '../hub'
import type { TextWatermarkSettings, UniverContribution } from '../types'

type ContributionItem = {
	sourcePlugin: string
	contribution: UniverContribution
	registeredAt: number
}

type WorkbookSnapshot = import('@univerjs/core').IWorkbookData
type SnapshotFile = { docId: string; savedAt: number; snapshot: WorkbookSnapshot }

function pickTextWatermark(items: ContributionItem[]): TextWatermarkSettings | null {
	const list = items
		.filter((i) => i.contribution.type === 'watermark:text')
		.map((i) => i.contribution.settings)
	if (list.length === 0) return null
	return list[0] ?? null
}

export default function SheetsRoute() {
	const ctx = useExtensionContext('plugin')
	const ui = ctx.services.hmr.ui.UniverSheetsHub

	type UniverInstance = { api: SheetsUniverApi; settingsKey: string }
	const univerRef = useRef<UniverInstance | null>(null)
	const [univerApi, setUniverApi] = useState<SheetsUniverApi | null>(null)

	const [container, setContainer] = useState<HTMLDivElement | null>(null)
	const [items, setItems] = useState<ContributionItem[] | null>(null)
	const [settings, setSettings] = useState<SheetsHubSettings | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [snapshotMeta, setSnapshotMeta] = useState<{ docId: string; savedAt: number } | null>(null)
	const [snapshotBusy, setSnapshotBusy] = useState(false)
	const savingRef = useRef(false)
	const applyingRef = useRef(false)
	const lastAutoLoadKeyRef = useRef<string | null>(null)
	const didInitDocIdRef = useRef(false)

	const [activeDocId, setActiveDocId] = useState('default')
	const [knownDocs, setKnownDocs] = useState<UniverSheetsDocInfo[]>([])

	const load = useCallback(async () => {
		setLoading(true)
		try {
			const boot = await ui.bootstrap()
			setSettings(boot.settings)
			setItems(boot.contributions)
			setError(null)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setLoading(false)
		}
	}, [ui])

	useEffect(() => {
		void load()
	}, [load])

	const watermark = useMemo(() => (items ? pickTextWatermark(items) : null), [items])
	const settingsKey = useMemo(() => (settings ? JSON.stringify(settings) : null), [settings])

	const persistence = settings?.persistence
	const persistenceEnabled = !!persistence?.enabled
	const persistenceDocId = persistence?.docId ?? 'default'

	useEffect(() => {
		if (!persistenceEnabled) return
		if (didInitDocIdRef.current) return
		didInitDocIdRef.current = true
		setActiveDocId(persistenceDocId)
	}, [persistenceDocId, persistenceEnabled])

	const refreshDocs = useCallback(async () => {
		try {
			const list = await ui.docs()
			setKnownDocs(list)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		}
	}, [ui])

	useEffect(() => {
		void refreshDocs()
	}, [refreshDocs])

	const saveSnapshot = useCallback(async (): Promise<void> => {
		if (!persistenceEnabled) return
		const docId = activeDocId.trim() || 'default'
		const api = univerApi
		if (!api) return
		if (savingRef.current) return
		const workbook = api.getActiveWorkbook()
		if (!workbook) return

		savingRef.current = true
		setSnapshotBusy(true)
		try {
			const snapshot = workbook.save()
			const res = await ui.saveSnapshot(docId, snapshot as WorkbookSnapshot)
			setSnapshotMeta({ docId, savedAt: res.savedAt })
			setError(null)
			void refreshDocs()
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			savingRef.current = false
			setSnapshotBusy(false)
		}
	}, [activeDocId, persistenceEnabled, refreshDocs, ui, univerApi])

	const loadSnapshot = useCallback(async (): Promise<void> => {
		if (!persistenceEnabled) return
		const docId = activeDocId.trim() || 'default'
		const api = univerApi
		if (!api) return

		setSnapshotBusy(true)
		try {
			const file = (await ui.loadSnapshot(docId)) as SnapshotFile | null
			if (!file?.snapshot) return

			applyingRef.current = true
			const current = api.getActiveWorkbook()
			const unitId = current?.getId()
			if (unitId) api.disposeUnit(unitId)

			api.createWorkbook(file.snapshot)
			setSnapshotMeta({ docId: file.docId, savedAt: file.savedAt })
			setError(null)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			// allow one tick for Univer internal commands triggered by init
			setTimeout(() => {
				applyingRef.current = false
			}, 0)
			setSnapshotBusy(false)
		}
	}, [activeDocId, persistenceEnabled, ui, univerApi])

	const deleteSnapshot = useCallback(async (): Promise<void> => {
		if (!persistenceEnabled) return
		const docId = activeDocId.trim() || 'default'
		if (!window.confirm(`删除快照？\n\ndocId: ${docId}`)) return
		setSnapshotBusy(true)
		try {
			await ui.deleteSnapshot(docId)
			setSnapshotMeta(null)
			setError(null)
			void refreshDocs()
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setSnapshotBusy(false)
		}
	}, [activeDocId, persistenceEnabled, refreshDocs, ui])

	const newDocId = useCallback(() => {
		const id = `book-${Date.now().toString(36)}`
		setActiveDocId(id)
		setSnapshotMeta(null)
		const api = univerApi
		if (!api) return
		const current = api.getActiveWorkbook()
		const unitId = current?.getId()
		if (unitId) api.disposeUnit(unitId)
		api.createWorkbook({})
	}, [univerApi])

	useEffect(() => {
		if (!container) return
		if (!settings) return

		const currentSettingsKey = settingsKey ?? JSON.stringify(settings)
		const current = univerRef.current
		if (current && current.settingsKey === currentSettingsKey) return
		if (current) {
			try {
				current.api.dispose()
			} catch {
				// ignore
			}
			univerRef.current = null
			setUniverApi(null)
		}

		const univerAPI = createSheetsUniver({ container, settings })
		univerRef.current = { api: univerAPI, settingsKey: currentSettingsKey }
		setUniverApi(univerAPI)

		return () => {
			univerRef.current = null
			setUniverApi(null)
			univerAPI.dispose()
		}
	}, [container, settings])

	useEffect(() => {
		const api = univerApi
		if (!api) return
		applyTextWatermark(api, watermark)
	}, [univerApi, watermark])

	useEffect(() => {
		if (!univerApi) return
		if (!persistenceEnabled) return
		if (!persistence?.autoLoadOnStart) return

		const docId = activeDocId.trim() || 'default'
		const key = `${settingsKey ?? ''}:${docId}:${univerApi ? '1' : '0'}`
		if (lastAutoLoadKeyRef.current === key) return
		lastAutoLoadKeyRef.current = key
		void loadSnapshot()
	}, [activeDocId, loadSnapshot, persistence?.autoLoadOnStart, persistenceEnabled, settingsKey, univerApi])

	useEffect(() => {
		if (!univerApi) return
		if (!persistenceEnabled) return
		if (!persistence?.autoSave) return

		const rawDebounce = Number(persistence.autoSaveDebounceMs ?? 800)
		const debounceMs = Number.isFinite(rawDebounce) ? Math.max(100, rawDebounce) : 800
		let timer: number | null = null
		const dispose = univerApi.addEvent(univerApi.Event.CommandExecuted, () => {
			if (applyingRef.current) return
			if (timer) window.clearTimeout(timer)
			timer = window.setTimeout(() => void saveSnapshot(), debounceMs)
		})

		return () => {
			dispose.dispose()
			if (timer) window.clearTimeout(timer)
		}
	}, [
		persistence?.autoSave,
		persistence?.autoSaveDebounceMs,
		persistenceEnabled,
		saveSnapshot,
		univerApi,
	])

	return (
		<div style={{ height: '100dvh', width: '100%', overflow: 'hidden' }}>
			<div
				ref={setContainer}
				style={{
					height: '100%',
					width: '100%',
					overflow: 'hidden',
					position: 'relative',
					background: '#fff',
				}}
			/>

			<div
				style={{
					position: 'fixed',
					top: 12,
					right: 12,
					zIndex: 1000,
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					padding: '8px 10px',
					borderRadius: 10,
					background: 'rgba(0,0,0,0.55)',
					color: 'rgba(255,255,255,0.92)',
					backdropFilter: 'blur(10px)',
					WebkitBackdropFilter: 'blur(10px)',
					fontSize: 12,
					lineHeight: 1,
					maxWidth: 'min(680px, calc(100vw - 24px))',
				}}
			>
				<a
					href="/"
					style={{
						color: 'rgba(255,255,255,0.92)',
						textDecoration: 'none',
						padding: '6px 8px',
						borderRadius: 8,
						background: 'rgba(255,255,255,0.12)',
					}}
				>
					← 宿主
				</a>

				<button
					type="button"
					onClick={() => void load()}
					disabled={loading}
					style={{
						cursor: loading ? 'progress' : 'pointer',
						border: 'none',
						color: 'rgba(255,255,255,0.92)',
						padding: '6px 10px',
						borderRadius: 8,
						background: loading ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.16)',
					}}
				>
					{loading ? '刷新中…' : '刷新 (配置/贡献)'}
				</button>

				{persistenceEnabled ? (
					<>
						<input
							value={activeDocId}
							onChange={(e) => setActiveDocId(e.currentTarget.value)}
							list="univer-doc-ids"
							placeholder="docId"
							style={{
								width: 180,
								border: 'none',
								color: 'rgba(255,255,255,0.92)',
								padding: '6px 10px',
								borderRadius: 8,
								background: 'rgba(255,255,255,0.12)',
								outline: 'none',
							}}
						/>
						<datalist id="univer-doc-ids">
							{knownDocs.map((d) => (
								<option key={d.docId} value={d.docId} />
							))}
						</datalist>

						<button
							type="button"
							onClick={() => newDocId()}
							disabled={snapshotBusy}
							style={{
								cursor: snapshotBusy ? 'progress' : 'pointer',
								border: 'none',
								color: 'rgba(255,255,255,0.92)',
								padding: '6px 10px',
								borderRadius: 8,
								background: snapshotBusy ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.16)',
							}}
						>
							新建
						</button>

						<button
							type="button"
							onClick={() => void loadSnapshot()}
							disabled={snapshotBusy}
							style={{
								cursor: snapshotBusy ? 'progress' : 'pointer',
								border: 'none',
								color: 'rgba(255,255,255,0.92)',
								padding: '6px 10px',
								borderRadius: 8,
								background: snapshotBusy ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.16)',
							}}
						>
							加载
						</button>
						<button
							type="button"
							onClick={() => void saveSnapshot()}
							disabled={snapshotBusy}
							style={{
								cursor: snapshotBusy ? 'progress' : 'pointer',
								border: 'none',
								color: 'rgba(255,255,255,0.92)',
								padding: '6px 10px',
								borderRadius: 8,
								background: snapshotBusy ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.16)',
							}}
						>
							保存
						</button>
						<button
							type="button"
							onClick={() => void deleteSnapshot()}
							disabled={snapshotBusy}
							style={{
								cursor: snapshotBusy ? 'progress' : 'pointer',
								border: 'none',
								color: 'rgba(255,255,255,0.92)',
								padding: '6px 10px',
								borderRadius: 8,
								background: snapshotBusy ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.16)',
							}}
						>
							删除
						</button>
						{snapshotMeta ? (
							<span style={{ opacity: 0.9 }}>
								快照：<b style={{ fontWeight: 600 }}>{new Date(snapshotMeta.savedAt).toLocaleString()}</b>
							</span>
						) : (
							<span style={{ opacity: 0.9 }}>快照：无</span>
						)}
						<span style={{ opacity: 0.85 }}>共 {knownDocs.length} 个</span>
					</>
				) : null}

				<span style={{ opacity: 0.9 }}>
					水印：<b style={{ fontWeight: 600 }}>{watermark ? '启用' : '关闭'}</b>
					{watermark ? ` (${watermark.content})` : ''}
				</span>

				{error ? (
					<span style={{ color: 'rgba(255, 120, 120, 0.95)' }}>错误：{error}</span>
				) : null}
			</div>
		</div>
	)
}
