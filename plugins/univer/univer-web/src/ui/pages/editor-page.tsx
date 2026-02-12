import { Banner, Button, Space, Typography } from '@douyinfe/semi-ui-19'
import { IconDeviceFloppy, IconRefresh } from '@tabler/icons-react'
import type { PluginExtensionContext } from '@pluxel/hmr/web'
import { rpcErrorMessage } from '@pluxel/hmr/web'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { UniverAutosavePolicy, UniverOpenWorkbookResult } from 'pluxel-plugin-univer-workbooks'

import { sha256Hex } from '../crypto'
import { parseWorkbookId } from '../shared'
import { AiPanel } from '../ai/ai-panel'
import { AiFloatWindow } from '../ai/ai-float-window'
import type { LoopbackBackend } from '../ai/loopback-backend'
import { createHttpLoopbackBackend } from '../ai/loopback-http'
import { parsePluginsRemove, parsePluginsSnapshot, parsePluginsUpsert } from '../univer/plugins-sse'
import { createUniverRuntime, type UniverRuntime } from '../univer/runtime'
import {
	UNIVER_CAP_AI,
	UNIVER_PLUGINS_SSE_NS,
	type UniverAiCapability,
	type UniverCapabilitiesSnapshot,
	type UniverLoopbackRpc,
	type UniverPluginSpec,
	type UniverRpc,
} from '@pluxel/univer-headless/protocol'
import { isSupportedUniverPluginKey } from '../univer/catalog'
import { DebugDrawer } from '../debug/debug-drawer'
import { CodeInline } from '../kit'

type SaveState = 'idle' | 'saving' | 'conflict' | 'error'
type SaveReason = 'manual' | 'auto' | 'init'

export function UniverEditorPage({ ctx }: { ctx: PluginExtensionContext }) {
	const rpc = (ctx.services.hmr.ui as any)?.UniverWorkbooks as
		| {
				openWorkbook: (id: string) => Promise<UniverOpenWorkbookResult>
				beginSave: (input: { id: string; baseRev: number; sha256: string; byteSize: number }) => Promise<unknown>
				commitSave: (input: { id: string; uploadId: string; commitToken: string }) => Promise<unknown>
		  }
		| null
	const sse = ctx.services.hmr.sse

	const workbookId = parseWorkbookId(ctx.pathname) ?? ''
	const mountRef = useRef<HTMLDivElement | null>(null)
	const rtRef = useRef<UniverRuntime | null>(null)
	const commandOffRef = useRef<{ dispose(): void } | null>(null)
	const workbookNameRef = useRef<string>('Univer')

	// Backend-driven Univer frontend plugins (SSE).
	const pluginsByIdRef = useRef(new Map<string, UniverPluginSpec>())
	const pluginSeqByIdRef = useRef(new Map<string, number>())
	const pluginSeqRef = useRef(0)
	const effectivePluginsByKeyRef = useRef(new Map<string, UniverPluginSpec>())

	const autosaveRef = useRef<UniverAutosavePolicy | null>(null)
	const baseRevRef = useRef(0)
	const latestRevRef = useRef(0)
	const latestEtagRef = useRef<string | null>(null)

	const dirtyRef = useRef(false)
	const lastEditAtRef = useRef<number | null>(null)
	const lastSaveAtRef = useRef<number | null>(null)
	const saveTimerRef = useRef<number | null>(null)

	const [title, setTitle] = useState('Univer')
	const [ready, setReady] = useState(false)
	const [dirty, setDirty] = useState(false)
	const [runtimeSeq, setRuntimeSeq] = useState(0)
	const [saveState, setSaveState] = useState<SaveState>('idle')
	const [saveError, setSaveError] = useState<string | null>(null)
	const [conflictRev, setConflictRev] = useState<number | null>(null)

	const [aiOpen, setAiOpen] = useState(false)
	const [aiOpenSeq, setAiOpenSeq] = useState(0)
	const [debugOpen, setDebugOpen] = useState(false)
	const openAiPanel = useCallback(() => {
		setAiOpen(true)
		setAiOpenSeq((v) => v + 1)
	}, [])

	const univerRpc = useMemo(() => {
		return (((ctx.services.hmr.ui as any).Univer as UniverRpc | undefined) ?? null) satisfies UniverRpc | null
	}, [ctx.services.hmr.ui])

	const univerLoopbackRpc = useMemo(() => {
		return (((ctx.services.hmr.ui as any).UniverLoopback as UniverLoopbackRpc | undefined) ?? null) satisfies UniverLoopbackRpc | null
	}, [ctx.services.hmr.ui])

	const isAiCapability = useCallback((value: unknown): value is UniverAiCapability => {
		if (!value || typeof value !== 'object') return false
		const available = (value as UniverAiCapability).available
		if (typeof available !== 'boolean') return false
		const defaultProfile = (value as UniverAiCapability).defaultProfile
		if (defaultProfile === undefined) return true
		if (!defaultProfile || typeof defaultProfile !== 'object') return false
		if (typeof (defaultProfile as any).id !== 'string' || !(defaultProfile as any).id) return false
		if (typeof (defaultProfile as any).provider !== 'string' || !(defaultProfile as any).provider) return false
		if ((defaultProfile as any).model !== undefined && typeof (defaultProfile as any).model !== 'string') return false
		if ((defaultProfile as any).baseURL !== undefined && typeof (defaultProfile as any).baseURL !== 'string') return false
		const reason = (value as UniverAiCapability).reason
		if (reason !== undefined && typeof reason !== 'string') return false
		return true
	}, [])

	const decodeAiCapability = useCallback((snap: UniverCapabilitiesSnapshot): UniverAiCapability => {
		const raw = snap.items[UNIVER_CAP_AI]
		if (!raw) return { available: false, reason: 'AI capability missing' }
		if (!raw.ok) return { available: false, reason: raw.error || 'AI capability error' }
		if (!isAiCapability(raw.value)) return { available: false, reason: 'AI capability invalid' }
		return raw.value
	}, [isAiCapability])

	const [univerCaps, setUniverCaps] = useState<UniverCapabilitiesSnapshot | null>(null)
	const [aiCaps, setAiCaps] = useState<UniverAiCapability | null>(null)
	const aiEntryEnabled = Boolean(univerLoopbackRpc && aiCaps?.available)

	const loopbackBackend = useMemo<LoopbackBackend | null>(() => {
		if (!univerLoopbackRpc) return null
		// Prefer HTTP for long-running LLM tasks (RPC client may have short timeouts).
		return createHttpLoopbackBackend()
	}, [univerLoopbackRpc])

	useEffect(() => {
		if (!univerRpc) {
			setUniverCaps(null)
			setAiCaps(null)
			return
		}

		let disposed = false
		const refresh = async () => {
			try {
				const snap = await univerRpc.capabilities()
				if (!disposed) setUniverCaps(snap)
				const caps = decodeAiCapability(snap)
				if (!disposed) setAiCaps(caps)
			} catch (err) {
				if (!disposed) setAiCaps({ available: false, reason: rpcErrorMessage(err, 'AI capabilities 失败') })
			}
		}

		void refresh()
		const timer = window.setInterval(refresh, 15_000)
		return () => {
			disposed = true
			window.clearInterval(timer)
		}
	}, [decodeAiCapability, univerRpc])

	const saveStateRef = useRef<SaveState>('idle')
	useEffect(() => {
		saveStateRef.current = saveState
	}, [saveState])

	const doSaveRef = useRef<((reason: SaveReason) => Promise<void> | void) | null>(null)

	const scheduleAutosave = useCallback(() => {
		const policy = autosaveRef.current
		if (!policy) return
		if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)

		const now = Date.now()
		const lastEditAt = lastEditAtRef.current ?? now
		const lastSaveAt = lastSaveAtRef.current ?? 0
		const baseSaveAt = lastSaveAt || now

		const dueAt = Math.max(lastEditAt + policy.debounceMs, baseSaveAt + policy.minIntervalMs)
		const maxDueAt = baseSaveAt + policy.maxIntervalMs
		const targetAt = policy.maxIntervalMs > 0 ? Math.min(dueAt, maxDueAt) : dueAt
		const wait = Math.max(0, targetAt - now)

		saveTimerRef.current = window.setTimeout(() => {
			saveTimerRef.current = null
			void doSaveRef.current?.('auto')
		}, wait)
	}, [])

	const recomputeEffectivePlugins = useCallback(() => {
		const byId = pluginsByIdRef.current
		const seqById = pluginSeqByIdRef.current

		const best = new Map<string, { spec: UniverPluginSpec; seq: number }>()
		for (const [id, spec] of byId) {
			const seq = seqById.get(id) ?? 0
			const prev = best.get(spec.key)
			if (!prev || seq > prev.seq) best.set(spec.key, { spec, seq })
		}

		const effective = new Map<string, UniverPluginSpec>()
		for (const [key, value] of best) effective.set(key, value.spec)
		effectivePluginsByKeyRef.current = effective
	}, [])

	const desiredInstalledPluginKeys = useCallback((): string[] => {
		const keys = [...effectivePluginsByKeyRef.current.keys()].filter((k) => isSupportedUniverPluginKey(k))
		keys.sort((a, b) => a.localeCompare(b))
		return keys
	}, [])

	const applyFrontendPlugins = useCallback((rt: UniverRuntime) => {
		const wm = effectivePluginsByKeyRef.current.get('watermark')?.config ?? null
		if (wm) rt.applyWatermark(wm)
		else rt.clearWatermark()
	}, [])

	const attachDirtyListener = useCallback(() => {
		const rt = rtRef.current
		commandOffRef.current?.dispose()
		commandOffRef.current = null
		if (!rt) return

		commandOffRef.current = rt.api.addEvent(rt.api.Event.CommandExecuted, () => {
			dirtyRef.current = true
			lastEditAtRef.current = Date.now()
			setDirty(true)
			if (saveStateRef.current !== 'conflict') scheduleAutosave()
		})
	}, [scheduleAutosave])

	const ensureRuntimePlugins = useCallback(() => {
		const mountEl = mountRef.current
		const rt = rtRef.current
		if (!mountEl || !rt) return

		const desired = desiredInstalledPluginKeys()
		const current = [...rt.installedPlugins].sort((a, b) => a.localeCompare(b))
		const desiredSig = desired.join('|')
		const currentSig = current.join('|')
		if (desiredSig === currentSig && rt.aiEntryEnabled === aiEntryEnabled) {
			applyFrontendPlugins(rt)
			return
		}

		let snapshot: unknown | undefined
		try {
			snapshot = JSON.parse(rt.saveSnapshotJson()) as unknown
		} catch {
			snapshot = undefined
		}

		rt.dispose()
		rtRef.current = null
		commandOffRef.current?.dispose()
		commandOffRef.current = null

		// Best-effort clear: UniverUIPlugin may leave DOM behind on fast toggles.
		mountEl.innerHTML = ''

		const next = createUniverRuntime({
			mountEl,
			workbookId,
			workbookName: workbookNameRef.current,
			snapshot,
			installedPlugins: desired,
			aiEntryEnabled,
			onAiOpen: openAiPanel,
		})
		rtRef.current = next
		setRuntimeSeq((v) => v + 1)
		attachDirtyListener()
		applyFrontendPlugins(next)
	}, [aiEntryEnabled, applyFrontendPlugins, attachDirtyListener, desiredInstalledPluginKeys, workbookId])

	const doSave = useCallback(
		async (reason: SaveReason) => {
			if (!rpc) {
				setSaveState('error')
				setSaveError('UniverWorkbooks RPC 未启用')
				return
			}
			if (!dirtyRef.current && reason !== 'init') return
			if (saveStateRef.current === 'saving') return
			if (!workbookId) return
			const rt = rtRef.current
			if (!rt) return

			setSaveState('saving')
			setSaveError(null)
			setConflictRev(null)

			let json = ''
			try {
				json = rt.saveSnapshotJson()
			} catch (err) {
				setSaveState('error')
				setSaveError(rpcErrorMessage(err, '读取快照失败'))
				return
			}

			const buf = new TextEncoder().encode(json)
			const sha256 = await sha256Hex(buf)
			const byteSize = buf.byteLength

			const baseRev = baseRevRef.current
			let begin
			try {
				begin = await rpc.beginSave({ id: workbookId, baseRev, sha256, byteSize })
			} catch (err) {
				setSaveState('error')
				setSaveError(rpcErrorMessage(err, 'beginSave 失败'))
				return
			}

			if ((begin as any).conflict) {
				setSaveState('conflict')
				setConflictRev((begin as any).currentRev ?? null)
				return
			}

			try {
				const res = await fetch((begin as any).uploadUrl, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: json,
				})
				if (!res.ok) {
					const text = await res.text().catch(() => '')
					throw new Error(`upload failed: ${res.status} ${text}`)
				}
			} catch (err) {
				setSaveState('error')
				setSaveError(rpcErrorMessage(err, '上传失败'))
				return
			}

			let committed
			try {
				committed = await rpc.commitSave({
					id: workbookId,
					uploadId: (begin as any).uploadId,
					commitToken: (begin as any).commitToken,
				})
			} catch (err) {
				setSaveState('error')
				setSaveError(rpcErrorMessage(err, 'commitSave 失败'))
				return
			}

			if ((committed as any).conflict) {
				setSaveState('conflict')
				setConflictRev((committed as any).currentRev ?? null)
				return
			}

			const newRev = (committed as any).newRev as number
			const newEtag = (committed as any).newEtag as string
			baseRevRef.current = newRev
			latestRevRef.current = newRev
			latestEtagRef.current = newEtag
			lastSaveAtRef.current = Date.now()

			dirtyRef.current = false
			setDirty(false)
			setSaveState('idle')
			setSaveError(null)
		},
		[workbookId, rpc],
	)

	useEffect(() => {
		doSaveRef.current = doSave
	}, [doSave])

	const reloadLatest = useCallback(async () => {
		if (!rpc) return
		if (!workbookId) return
		setSaveState('saving')
		setSaveError(null)
		setConflictRev(null)

		let info: UniverOpenWorkbookResult
		try {
			info = await rpc.openWorkbook(workbookId)
		} catch (err) {
			setSaveState('error')
			setSaveError(rpcErrorMessage(err, 'openWorkbook 失败'))
			return
		}

		const snapshot = info.latestSnapshotUrl ? await fetch(info.latestSnapshotUrl).then((r) => (r.ok ? r.json() : undefined)) : undefined

		const mountEl = mountRef.current
		if (!mountEl) return

		commandOffRef.current?.dispose()
		commandOffRef.current = null
		rtRef.current?.dispose()
		rtRef.current = null
		mountEl.innerHTML = ''

		workbookNameRef.current = info.name
		const desired = desiredInstalledPluginKeys()
		rtRef.current = createUniverRuntime({
			mountEl,
			workbookId: info.id,
			workbookName: info.name,
			snapshot,
			installedPlugins: desired,
			aiEntryEnabled,
			onAiOpen: openAiPanel,
		})
		setRuntimeSeq((v) => v + 1)
		attachDirtyListener()
		ensureRuntimePlugins()

		baseRevRef.current = info.latestRev
		latestRevRef.current = info.latestRev
		latestEtagRef.current = info.latestEtag

		dirtyRef.current = false
		setDirty(false)
		setSaveState('idle')
		setSaveError(null)
		setConflictRev(null)
	}, [aiEntryEnabled, attachDirtyListener, desiredInstalledPluginKeys, ensureRuntimePlugins, rpc, workbookId])

	const getRuntime = useCallback(() => rtRef.current, [])

	useEffect(() => {
		if (!ready) return
		ensureRuntimePlugins()
		if (!aiEntryEnabled) setAiOpen(false)
	}, [aiEntryEnabled, ensureRuntimePlugins, ready])

	useEffect(() => {
		const mountEl = mountRef.current
		if (!mountEl) return
		if (!workbookId) return
		if (!rpc) return

		let disposed = false
		;(async () => {
			try {
				const info: UniverOpenWorkbookResult = await rpc.openWorkbook(workbookId)
				autosaveRef.current = info.autosavePolicy
				baseRevRef.current = info.latestRev
				latestRevRef.current = info.latestRev
				latestEtagRef.current = info.latestEtag
				workbookNameRef.current = info.name

				setTitle(`${info.name} — Univer`)

				let snapshot: unknown | undefined
				if (info.latestSnapshotUrl) {
					const res = await fetch(info.latestSnapshotUrl)
					if (res.ok) snapshot = await res.json()
				}

				if (disposed) return
				const desired = desiredInstalledPluginKeys()
				rtRef.current = createUniverRuntime({
					mountEl,
					workbookId: info.id,
					workbookName: info.name,
					snapshot,
					installedPlugins: desired,
					aiEntryEnabled,
					onAiOpen: openAiPanel,
				})
				setRuntimeSeq((v) => v + 1)

				attachDirtyListener()
				ensureRuntimePlugins()

				setReady(true)
				setSaveState('idle')
				setSaveError(null)

				if (info.latestRev === 0) {
					dirtyRef.current = true
					setDirty(true)
					await doSave('init')
				}
			} catch (err) {
				setReady(false)
				setSaveState('error')
				setSaveError(rpcErrorMessage(err, '加载失败'))
			}
		})()

		return () => {
			disposed = true
			commandOffRef.current?.dispose()
			commandOffRef.current = null
			if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
			saveTimerRef.current = null
			rtRef.current?.dispose()
			rtRef.current = null
			setReady(false)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [aiEntryEnabled, attachDirtyListener, doSave, desiredInstalledPluginKeys, ensureRuntimePlugins, rpc, scheduleAutosave, workbookId])

	useEffect(() => {
		const off = sse.ns(UNIVER_PLUGINS_SSE_NS).on(
			(msg) => {
				const event = msg.event
				const payload = msg.payload

				if (event === 'snapshot') {
					const p = parsePluginsSnapshot(payload)
					if (!p) return
					pluginsByIdRef.current.clear()
					pluginSeqByIdRef.current.clear()
					for (const spec of p.items) {
						pluginsByIdRef.current.set(spec.id, spec)
						pluginSeqByIdRef.current.set(spec.id, ++pluginSeqRef.current)
					}
					recomputeEffectivePlugins()
					ensureRuntimePlugins()
					return
				}

				if (event === 'upsert') {
					const p = parsePluginsUpsert(payload)
					if (!p) return
					pluginsByIdRef.current.set(p.item.id, p.item)
					pluginSeqByIdRef.current.set(p.item.id, ++pluginSeqRef.current)
					recomputeEffectivePlugins()
					ensureRuntimePlugins()
					return
				}

				if (event === 'remove') {
					const p = parsePluginsRemove(payload)
					if (!p) return
					pluginsByIdRef.current.delete(p.id)
					pluginSeqByIdRef.current.delete(p.id)
					recomputeEffectivePlugins()
					ensureRuntimePlugins()
				}
			},
			['snapshot', 'upsert', 'remove'],
		)
			return () => off()
	}, [ensureRuntimePlugins, recomputeEffectivePlugins, sse])

	if (!rpc) {
		return (
			<Banner
				fullMode={false}
				type="warning"
				title="UniverWorkbooks 未启用"
				description={
					<Space vertical align="start" spacing="tight">
						<div>
							当前后端没有提供 <CodeInline>UniverWorkbooks</CodeInline> RPC，无法打开工作簿。
						</div>
						<div>
							请启用 <CodeInline>pluxel-plugin-univer-workbooks</CodeInline>（profile:{' '}
							<CodeInline>pluxel.hmr.jsonc</CodeInline>），然后刷新页面。
						</div>
					</Space>
				}
			/>
		)
	}

	return (
		<div className="univer-standalone">
			<div className="univer-standalone__header">
				<div className="univer-standalone__header-top">
					<div>
						<Typography.Text strong>{title}</Typography.Text>
						<div className="univer-standalone__meta">
							rev: <CodeInline>{latestRevRef.current}</CodeInline> · base: <CodeInline>{baseRevRef.current}</CodeInline> ·{' '}
							{dirty ? 'dirty' : 'clean'}
						</div>
					</div>

					<div className="univer-standalone__actions">
						<Button theme="borderless" size="small" disabled={!ready} onClick={() => setDebugOpen(true)}>
							Debug
						</Button>

						<Button
							type="primary"
							size="small"
							icon={<IconDeviceFloppy size={16} />}
							disabled={!ready || saveState === 'saving'}
							onClick={() => void doSave('manual')}
						>
							保存
						</Button>
					</div>
				</div>

				{saveState === 'conflict' ? (
					<div style={{ marginTop: 12 }}>
						<Banner
							fullMode={false}
							type="warning"
							title="版本冲突"
							description={
								<Space vertical align="start" spacing="tight">
									<div>
										远端已更新到 rev <CodeInline>{conflictRev ?? '?'}</CodeInline>。请重新加载最新版本后再保存（本地未保存改动将丢失）。
									</div>
									<Button size="small" icon={<IconRefresh size={14} />} onClick={() => void reloadLatest()}>
										重新加载
									</Button>
								</Space>
							}
						/>
					</div>
				) : null}

				{saveState === 'error' && saveError ? (
					<div style={{ marginTop: 12 }}>
						<Banner fullMode={false} type="danger" title="保存失败" description={saveError} />
					</div>
				) : null}
			</div>

			<div className="univer-standalone__body">
				<div ref={mountRef} className="univer-standalone__mount" />
			</div>

			<AiFloatWindow open={aiOpen} openSeq={aiOpenSeq} onOpenChange={setAiOpen} title="AI">
				<AiPanel
					ready={ready}
					workbookId={workbookId}
					getRuntime={getRuntime}
					runtimeSeq={runtimeSeq}
					backend={loopbackBackend}
					onReloadLatest={reloadLatest}
					dirty={dirty}
				/>
			</AiFloatWindow>

			<DebugDrawer
				opened={debugOpen}
				onClose={() => setDebugOpen(false)}
				ready={ready}
				workbookId={workbookId}
				aiThreadId={workbookId ? `univer:loopback:${workbookId}` : undefined}
				createSse={ctx.services.hmr.createSse}
				getRuntime={getRuntime}
				effectivePlugins={() => [...effectivePluginsByKeyRef.current.values()]}
				rawPlugins={() => [...pluginsByIdRef.current.values()]}
				services={{
					workbooks: Boolean((ctx.services.hmr.ui as any).UniverWorkbooks),
					ai: Boolean(loopbackBackend && aiEntryEnabled),
				}}
				capabilities={univerCaps}
			/>
		</div>
	)
}
