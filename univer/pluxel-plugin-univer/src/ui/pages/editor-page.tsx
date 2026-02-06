import { Alert, Button, Code, Drawer, Group, Stack, Text, Title } from '@mantine/core'
import { IconDeviceFloppy, IconRefresh, IconSparkles } from '@tabler/icons-react'
import type { PluginExtensionContext } from '@pluxel/hmr/web'
import { rpcErrorMessage } from '@pluxel/hmr/web'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { UniverAutosavePolicy, UniverOpenWorkbookResult } from 'pluxel-plugin-univer-workbooks'
import type { UniverAIRpc } from 'pluxel-plugin-univer-ai'

import { sha256Hex } from '../crypto'
import { parseWorkbookId } from '../shared'
import { AiPanel } from '../ai/ai-panel'
import { parsePluginsRemove, parsePluginsSnapshot, parsePluginsUpsert } from '../univer/plugins-sse'
import { createUniverRuntime, type UniverRuntime } from '../univer/runtime'
import { UNIVER_PLUGINS_SSE_NS } from '../../shared'

type SaveState = 'idle' | 'saving' | 'conflict' | 'error'

export function UniverEditorPage({ ctx }: { ctx: PluginExtensionContext }) {
	const rpc = ctx.services.hmr.ui.UniverWorkbooks
	const sse = ctx.services.hmr.sse

	const workbookId = parseWorkbookId(ctx.pathname) ?? ''
	const mountRef = useRef<HTMLDivElement | null>(null)
	const rtRef = useRef<UniverRuntime | null>(null)

	const autosaveRef = useRef<UniverAutosavePolicy | null>(null)
	const baseRevRef = useRef(0)
	const latestRevRef = useRef(0)
	const latestEtagRef = useRef<string | null>(null)

	const dirtyRef = useRef(false)
	const lastEditAtRef = useRef<number | null>(null)
	const lastSaveAtRef = useRef<number | null>(null)
	const saveTimerRef = useRef<number | null>(null)

	const watermarkSpecIdRef = useRef<string | null>(null)
	const watermarkConfigRef = useRef<unknown>(null)

	const [title, setTitle] = useState('Univer')
	const [ready, setReady] = useState(false)
	const [dirty, setDirty] = useState(false)
	const [saveState, setSaveState] = useState<SaveState>('idle')
	const [saveError, setSaveError] = useState<string | null>(null)
	const [conflictRev, setConflictRev] = useState<number | null>(null)

	const [aiOpen, setAiOpen] = useState(false)

	const saveStateRef = useRef<SaveState>('idle')
	useEffect(() => {
		saveStateRef.current = saveState
	}, [saveState])

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
			void doSave('auto')
		}, wait)
	}, [])

	const applyWatermark = useCallback(() => {
		const rt = rtRef.current
		if (!rt) return
		const cfg = watermarkConfigRef.current
		if (!cfg) {
			rt.clearWatermark()
			return
		}
		rt.applyWatermark(cfg)
	}, [])

	const doSave = useCallback(
		async (reason: 'manual' | 'auto' | 'init') => {
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

	const reloadLatest = useCallback(async () => {
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

		rtRef.current?.dispose()
		rtRef.current = createUniverRuntime({ mountEl, workbookId: info.id, workbookName: info.name, snapshot })

		baseRevRef.current = info.latestRev
		latestRevRef.current = info.latestRev
		latestEtagRef.current = info.latestEtag

		dirtyRef.current = false
		setDirty(false)
		setSaveState('idle')
		setSaveError(null)
		setConflictRev(null)
	}, [rpc, workbookId])

	const getRuntime = useCallback(() => rtRef.current, [])

	const aiRpc = useMemo(() => {
		return ((ctx.services.hmr.ui as any).UniverAI as UniverAIRpc | undefined) ?? null
	}, [ctx.services.hmr.ui])

	useEffect(() => {
		const mountEl = mountRef.current
		if (!mountEl) return
		if (!workbookId) return

		let disposed = false
		let commandOff: { dispose(): void } | null = null
		;(async () => {
			try {
				const info: UniverOpenWorkbookResult = await rpc.openWorkbook(workbookId)
				autosaveRef.current = info.autosavePolicy
				baseRevRef.current = info.latestRev
				latestRevRef.current = info.latestRev
				latestEtagRef.current = info.latestEtag

				setTitle(`${info.name} — Univer`)

				let snapshot: unknown | undefined
				if (info.latestSnapshotUrl) {
					const res = await fetch(info.latestSnapshotUrl)
					if (res.ok) snapshot = await res.json()
				}

				if (disposed) return
				rtRef.current = createUniverRuntime({
					mountEl,
					workbookId: info.id,
					workbookName: info.name,
					snapshot,
				})

				const rt = rtRef.current
				const off = rt.api.addEvent(rt.api.Event.CommandExecuted, () => {
					dirtyRef.current = true
					lastEditAtRef.current = Date.now()
					setDirty(true)
					if (saveStateRef.current !== 'conflict') scheduleAutosave()
				})
				commandOff = off

				applyWatermark()

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
			commandOff?.dispose()
			commandOff = null
			if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
			saveTimerRef.current = null
			rtRef.current?.dispose()
			rtRef.current = null
			setReady(false)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [applyWatermark, doSave, rpc, scheduleAutosave, workbookId])

	const handlers = useMemo(() => {
		const onUpsert = (spec: any) => {
			if (spec.plugin !== 'watermark') return
			watermarkSpecIdRef.current = spec.id
			watermarkConfigRef.current = spec.config ?? null
			applyWatermark()
		}
		const onRemove = (id: string) => {
			if (watermarkSpecIdRef.current !== id) return
			watermarkSpecIdRef.current = null
			watermarkConfigRef.current = null
			applyWatermark()
		}
		const onSnapshot = (plugins: readonly any[]) => {
			const wm = plugins.find((p) => p.plugin === 'watermark') ?? null
			watermarkSpecIdRef.current = wm?.id ?? null
			watermarkConfigRef.current = wm?.config ?? null
			applyWatermark()
		}
		return { onUpsert, onRemove, onSnapshot }
	}, [applyWatermark])

	useEffect(() => {
		const off = sse.ns(UNIVER_PLUGINS_SSE_NS).on(
			(msg) => {
				const event = msg.event
				const payload = msg.payload

				if (event === 'snapshot') {
					const p = parsePluginsSnapshot(payload)
					if (!p) return
					handlers.onSnapshot(p.plugins)
					return
				}

				if (event === 'upsert') {
					const p = parsePluginsUpsert(payload)
					if (!p) return
					handlers.onUpsert(p.plugin)
					return
				}

				if (event === 'remove') {
					const p = parsePluginsRemove(payload)
					if (!p) return
					handlers.onRemove(p.id)
				}
			},
			['snapshot', 'upsert', 'remove'],
		)
		return () => off()
	}, [handlers, sse])

	return (
		<div className="univer-standalone">
			<div className="univer-standalone__header">
				<Group justify="space-between" wrap="nowrap">
					<Stack gap={0} style={{ minWidth: 0 }}>
						<Title order={4} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
							{title}
						</Title>
						<Text size="xs" c="dimmed">
							rev: <Code>{latestRevRef.current}</Code> · base: <Code>{baseRevRef.current}</Code> · {dirty ? 'dirty' : 'clean'}
						</Text>
					</Stack>

					<Group gap="xs" wrap="nowrap">
						<Button
							size="sm"
							variant="subtle"
							leftSection={<IconSparkles size={16} />}
							disabled={!ready}
							onClick={() => setAiOpen(true)}
						>
							AI
						</Button>

						<Button
							size="sm"
							variant="light"
							leftSection={<IconDeviceFloppy size={16} />}
							disabled={!ready || saveState === 'saving'}
							loading={saveState === 'saving'}
							onClick={() => void doSave('manual')}
						>
							保存
						</Button>
					</Group>
				</Group>

				{saveState === 'conflict' ? (
					<Alert color="yellow" title="版本冲突" mt="sm">
						<Text size="sm">
							远端已更新到 rev <Code>{conflictRev ?? '?'}</Code>。请重新加载最新版本后再保存（本地未保存改动将丢失）。
						</Text>
						<Group mt="xs">
							<Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => void reloadLatest()}>
								重新加载
							</Button>
						</Group>
					</Alert>
				) : null}

				{saveState === 'error' && saveError ? (
					<Alert color="red" title="保存失败" mt="sm">
						{saveError}
					</Alert>
				) : null}
			</div>

			<div className="univer-standalone__body">
				<div ref={mountRef} className="univer-standalone__mount" />
			</div>

			<Drawer opened={aiOpen} onClose={() => setAiOpen(false)} position="right" size={520} title="AI" overlayProps={{ opacity: 0.15 }}>
				<AiPanel ready={ready} workbookId={workbookId} getRuntime={getRuntime} rpc={aiRpc} />
			</Drawer>
		</div>
	)
}

