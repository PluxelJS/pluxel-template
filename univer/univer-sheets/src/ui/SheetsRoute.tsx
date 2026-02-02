import { useExtensionContext } from '@pluxel/hmr/web'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import '@univerjs/design/lib/index.css'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css'
import '@univerjs/preset-sheets-data-validation/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-find-replace/lib/index.css'
import '@univerjs/preset-sheets-hyper-link/lib/index.css'
import '@univerjs/preset-sheets-note/lib/index.css'
import '@univerjs/preset-sheets-sort/lib/index.css'
import '@univerjs/preset-sheets-table/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'
import '@univerjs/preset-sheets-thread-comment/lib/index.css'
import '@univerjs/sheets-crosshair-highlight/lib/index.css'
import '@univerjs/sheets-zen-editor/lib/index.css'
import '@univerjs/uniscript/lib/index.css'

import { createUniver, defaultTheme, LocaleType, mergeLocales } from '@univerjs/presets'
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace'
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link'
import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note'
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort'
import { UniverSheetsTablePreset } from '@univerjs/preset-sheets-table'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import { UniverSheetsThreadCommentPreset } from '@univerjs/preset-sheets-thread-comment'
import sheetsEnUS from '@univerjs/preset-sheets-core/locales/en-US'
import sheetsZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import conditionalFormattingEnUS from '@univerjs/preset-sheets-conditional-formatting/locales/en-US'
import conditionalFormattingZhCN from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN'
import dataValidationEnUS from '@univerjs/preset-sheets-data-validation/locales/en-US'
import dataValidationZhCN from '@univerjs/preset-sheets-data-validation/locales/zh-CN'
import filterEnUS from '@univerjs/preset-sheets-filter/locales/en-US'
import filterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN'
import findReplaceEnUS from '@univerjs/preset-sheets-find-replace/locales/en-US'
import findReplaceZhCN from '@univerjs/preset-sheets-find-replace/locales/zh-CN'
import hyperLinkEnUS from '@univerjs/preset-sheets-hyper-link/locales/en-US'
import hyperLinkZhCN from '@univerjs/preset-sheets-hyper-link/locales/zh-CN'
import noteEnUS from '@univerjs/preset-sheets-note/locales/en-US'
import noteZhCN from '@univerjs/preset-sheets-note/locales/zh-CN'
import sortEnUS from '@univerjs/preset-sheets-sort/locales/en-US'
import sortZhCN from '@univerjs/preset-sheets-sort/locales/zh-CN'
import tableEnUS from '@univerjs/preset-sheets-table/locales/en-US'
import tableZhCN from '@univerjs/preset-sheets-table/locales/zh-CN'
import drawingEnUS from '@univerjs/preset-sheets-drawing/locales/en-US'
import drawingZhCN from '@univerjs/preset-sheets-drawing/locales/zh-CN'
import threadCommentEnUS from '@univerjs/preset-sheets-thread-comment/locales/en-US'
import threadCommentZhCN from '@univerjs/preset-sheets-thread-comment/locales/zh-CN'
import designEnUS from '@univerjs/design/locale/en-US'
import designZhCN from '@univerjs/design/locale/zh-CN'

import sheetsCrosshairHighlightEnUS from '@univerjs/sheets-crosshair-highlight/locale/en-US'
import sheetsCrosshairHighlightZhCN from '@univerjs/sheets-crosshair-highlight/locale/zh-CN'
import { UniverSheetsCrosshairHighlightPlugin } from '@univerjs/sheets-crosshair-highlight'
import '@univerjs/sheets-crosshair-highlight/facade'

import { UniverWatermarkPlugin } from '@univerjs/watermark'
import '@univerjs/watermark/facade'

import sheetsZenEditorEnUS from '@univerjs/sheets-zen-editor/locale/en-US'
import sheetsZenEditorZhCN from '@univerjs/sheets-zen-editor/locale/zh-CN'
import { UniverSheetsZenEditorPlugin } from '@univerjs/sheets-zen-editor'
import '@univerjs/sheets-zen-editor/facade'

import uniscriptEnUS from '@univerjs/uniscript/locale/en-US'
import uniscriptZhCN from '@univerjs/uniscript/locale/zh-CN'
import { UniverUniscriptPlugin } from '@univerjs/uniscript'

import type { SheetsHubSettings } from '../hub'
import type { TextWatermarkSettings, UniverContribution } from '../types'

type ContributionItem = {
	sourcePlugin: string
	contribution: UniverContribution
	registeredAt: number
}

type SnapshotMeta = { docId: string; savedAt: number }
type SnapshotFile = { docId: string; savedAt: number; snapshot: unknown }

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

	type UniverApi = ReturnType<typeof createUniver>['univerAPI']
	type UniverInstance = { api: UniverApi; settingsKey: string }
	const univerRef = useRef<UniverInstance | null>(null)
	const [univerApi, setUniverApi] = useState<UniverApi | null>(null)

	const [container, setContainer] = useState<HTMLDivElement | null>(null)
	const [items, setItems] = useState<ContributionItem[] | null>(null)
	const [settings, setSettings] = useState<SheetsHubSettings | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [snapshotMeta, setSnapshotMeta] = useState<SnapshotMeta | null>(null)
	const [snapshotBusy, setSnapshotBusy] = useState(false)
	const savingRef = useRef(false)
	const applyingRef = useRef(false)
	const lastAutoLoadKeyRef = useRef<string | null>(null)

	const load = useCallback(async () => {
		setLoading(true)
		try {
			const [nextSettings, next] = await Promise.all([ui.settings(), ui.contributions()])
			setSettings(nextSettings)
			setItems(next)
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

	const saveSnapshot = useCallback(async (): Promise<void> => {
		if (!persistenceEnabled) return
		const api = univerApi
		if (!api) return
		if (savingRef.current) return
		const workbook = api.getActiveWorkbook()
		if (!workbook) return

		savingRef.current = true
		setSnapshotBusy(true)
		try {
			const snapshot = workbook.save()
			const res = await ui.saveSnapshot(persistenceDocId, snapshot as any)
			setSnapshotMeta({ docId: persistenceDocId, savedAt: res.savedAt })
			setError(null)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			savingRef.current = false
			setSnapshotBusy(false)
		}
	}, [persistenceDocId, persistenceEnabled, ui, univerApi])

	const loadSnapshot = useCallback(async (): Promise<void> => {
		if (!persistenceEnabled) return
		const api = univerApi
		if (!api) return

		setSnapshotBusy(true)
		try {
			const file = (await ui.loadSnapshot(persistenceDocId)) as SnapshotFile | null
			if (!file?.snapshot) return

			applyingRef.current = true
			const current = api.getActiveWorkbook()
			const unitId = current?.getId()
			if (unitId) api.disposeUnit(unitId)

			api.createWorkbook(file.snapshot as any)
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
	}, [persistenceDocId, persistenceEnabled, ui, univerApi])

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

		const localeType = settings.locale === 'en-US' ? LocaleType.EN_US : LocaleType.ZH_CN
		const pickLocale = <T,>(en: T, zh: T) => (settings.locale === 'en-US' ? en : zh)

		const localePacks: any[] = [pickLocale(designEnUS, designZhCN), pickLocale(sheetsEnUS, sheetsZhCN)]
		const presets: any[] = [UniverSheetsCorePreset({ container })]
		const plugins: any[] = [UniverWatermarkPlugin]

		const enablePreset = (enabled: boolean, preset: any, localeEn: any, localeZh: any) => {
			if (!enabled) return
			localePacks.push(pickLocale(localeEn, localeZh))
			presets.push(preset)
		}
		const enablePlugin = (enabled: boolean, plugin: any, localeEn: any, localeZh: any) => {
			if (!enabled) return
			localePacks.push(pickLocale(localeEn, localeZh))
			plugins.push(plugin)
		}

		enablePreset(settings.enableFilter, UniverSheetsFilterPreset(), filterEnUS, filterZhCN)
		enablePreset(settings.enableSort, UniverSheetsSortPreset(), sortEnUS, sortZhCN)
		enablePreset(settings.enableFindReplace, UniverSheetsFindReplacePreset(), findReplaceEnUS, findReplaceZhCN)
		enablePreset(settings.enableNote, UniverSheetsNotePreset(), noteEnUS, noteZhCN)
		enablePreset(settings.enableHyperLink, UniverSheetsHyperLinkPreset(), hyperLinkEnUS, hyperLinkZhCN)
		enablePreset(settings.enableDataValidation, UniverSheetsDataValidationPreset(), dataValidationEnUS, dataValidationZhCN)
		enablePreset(settings.enableTable, UniverSheetsTablePreset(), tableEnUS, tableZhCN)
		enablePreset(settings.enableDrawing, UniverSheetsDrawingPreset(), drawingEnUS, drawingZhCN)
		enablePreset(
			settings.enableThreadComment,
			UniverSheetsThreadCommentPreset(),
			threadCommentEnUS,
			threadCommentZhCN,
		)
		enablePreset(
			settings.enableConditionalFormatting,
			UniverSheetsConditionalFormattingPreset(),
			conditionalFormattingEnUS,
			conditionalFormattingZhCN,
		)

		enablePlugin(
			settings.enableCrosshairHighlight,
			UniverSheetsCrosshairHighlightPlugin,
			sheetsCrosshairHighlightEnUS,
			sheetsCrosshairHighlightZhCN,
		)
		enablePlugin(settings.enableZenEditor, UniverSheetsZenEditorPlugin, sheetsZenEditorEnUS, sheetsZenEditorZhCN)
		enablePlugin(settings.enableUniscript, UniverUniscriptPlugin, uniscriptEnUS, uniscriptZhCN)

		const { univerAPI } = createUniver({
			locale: localeType,
			locales: { [localeType]: mergeLocales(...localePacks) },
			theme: defaultTheme,
			presets,
			plugins,
		})

		univerAPI.createWorkbook({})
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

		if (!watermark) {
			api.deleteWatermark()
			return
		}

		api.addWatermark(api.Enum.IWatermarkTypeEnum.Text, {
			content: watermark.content,
			repeat: watermark.repeat ?? true,
			x: 80,
			y: 60,
			spacingX: 260,
			spacingY: 190,
			rotate: watermark.rotate ?? -15,
			opacity: watermark.opacity ?? 0.2,
			fontSize: watermark.fontSize ?? 28,
			color: watermark.color ?? 'rgba(120, 120, 120, 0.28)',
			bold: false,
			italic: false,
			direction: 'ltr',
		})
	}, [univerApi, watermark])

	useEffect(() => {
		if (!univerApi) return
		if (!persistenceEnabled) return
		if (!persistence?.autoLoadOnStart) return

		const key = `${settingsKey ?? ''}:${persistenceDocId}:${univerApi ? '1' : '0'}`
		if (lastAutoLoadKeyRef.current === key) return
		lastAutoLoadKeyRef.current = key
		void loadSnapshot()
	}, [loadSnapshot, persistence?.autoLoadOnStart, persistenceDocId, persistenceEnabled, settingsKey, univerApi])

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
							加载 ({persistenceDocId})
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
							保存 ({persistenceDocId})
						</button>
						{snapshotMeta ? (
							<span style={{ opacity: 0.9 }}>
								快照：<b style={{ fontWeight: 600 }}>{new Date(snapshotMeta.savedAt).toLocaleString()}</b>
							</span>
						) : (
							<span style={{ opacity: 0.9 }}>快照：无</span>
						)}
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
