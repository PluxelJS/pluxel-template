import { useExtensionContext } from '@pluxel/hmr/web'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
	SheetsHubSettings,
	SheetsPatchAction,
	SheetsPatchSpec,
	StoredSnapshotFile,
	UniverSheetsDocInfo,
	UniverContribution,
} from 'pluxel-plugin-univer-sheets'
import type { SheetsUniverApi } from 'pluxel-plugin-univer-sheets/ui-kit'
import { applySheetsPatch, applyTextWatermark, createSheetsUniver } from 'pluxel-plugin-univer-sheets/ui-kit'

type ContributionItem = {
	sourcePlugin: string
	contribution: UniverContribution
	registeredAt: number
}

type SnapshotMeta = { docId: string; savedAt: number }
type SnapshotFile = StoredSnapshotFile

function pickWatermark(items: ContributionItem[]) {
	const list = items.filter((i) => i.contribution.type === 'watermark:text').map((i) => i.contribution.settings)
	return list[0] ?? null
}

type CellValue = import('@univerjs/core').CellValue
type ICellData = import('@univerjs/core').ICellData
type CellValues2D = CellValue[][]
type CellData2D = ICellData[][]

type EditAction =
	| { kind: 'setValue'; a1: string; value: string }
	| { kind: 'setFormula'; a1: string; formula: string }
	| { kind: 'setValuesJson'; a1: string; json: string }
	| { kind: 'clear'; a1: string }

function normalizeA1(raw: string): string {
	const a1 = String(raw ?? '').trim()
	if (!a1) return 'A1'
	return a1
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseSheetsPatchAction(value: unknown): SheetsPatchAction {
	if (!isPlainObject(value)) throw new Error('Patch action must be an object')
	const op = value.op
	if (op !== 'set' && op !== 'setValues' && op !== 'clear') throw new Error('Patch action op must be set|setValues|clear')

	const rangeRaw = value.range
	if (typeof rangeRaw !== 'string') throw new Error('Patch action range must be a string')
	const range = normalizeA1(rangeRaw)

	const sheetNameRaw = value.sheetName
	const sheetName = typeof sheetNameRaw === 'string' ? sheetNameRaw.trim() || undefined : undefined

	if (op === 'set') {
		if (!('value' in value)) throw new Error('Patch action (set) requires `value`')
		type SetValue = Extract<SheetsPatchAction, { op: 'set' }>['value']
		return { op, range, ...(sheetName ? { sheetName } : {}), value: value.value as SetValue }
	}
	if (op === 'setValues') {
		if (!('values' in value)) throw new Error('Patch action (setValues) requires `values`')
		type SetValues = Extract<SheetsPatchAction, { op: 'setValues' }>['values']
		return { op, range, ...(sheetName ? { sheetName } : {}), values: value.values as SetValues }
	}
	return { op, range, ...(sheetName ? { sheetName } : {}) }
}

function parseSheetsPatchSpecFromJson(raw: string): SheetsPatchSpec {
	const parsed: unknown = JSON.parse(raw)
	if (!isPlainObject(parsed)) throw new Error('Patch must be an object: { actions: [...] }')
	if (!Array.isArray(parsed.actions)) throw new Error('Patch must be { actions: [...] }')
	return { actions: parsed.actions.map(parseSheetsPatchAction) }
}

export default function StudioRoute() {
	const ctx = useExtensionContext('plugin')
	const hub = ctx.services.hmr.ui.UniverSheetsHub
	const sourceIdRef = useRef<string>(
		typeof globalThis.crypto?.randomUUID === 'function'
			? globalThis.crypto.randomUUID()
			: `studio-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	)

	const [container, setContainer] = useState<HTMLDivElement | null>(null)
	const univerRef = useRef<{ api: SheetsUniverApi; settingsKey: string } | null>(null)
	const [univerApi, setUniverApi] = useState<SheetsUniverApi | null>(null)

	const appliedSeqRef = useRef(0)
	const [appliedSeq, setAppliedSeq] = useState(0)

	const [items, setItems] = useState<ContributionItem[] | null>(null)
	const [settings, setSettings] = useState<SheetsHubSettings | null>(null)
	const [knownDocs, setKnownDocs] = useState<UniverSheetsDocInfo[]>([])
	const [activeDocId, setActiveDocId] = useState('default')

	const [a1, setA1] = useState('A1')
	const [value, setValue] = useState('Hello')
	const [json, setJson] = useState('[[\"A1\",\"B1\"],[1,2]]')
	const [formula, setFormula] = useState('=SUM(1,2,3)')
	const [patch, setPatch] = useState(
		JSON.stringify(
			{
				actions: [
					{ op: 'set', range: 'A1', value: 'Hello' },
					{ op: 'set', range: 'B1', value: 123 },
					{ op: 'setValues', range: 'A2:B3', values: [[1, 2], [3, 4]] },
					{ op: 'clear', range: 'C1:C3' },
				],
			},
			null,
			2,
		),
	)

	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [snapshotMeta, setSnapshotMeta] = useState<SnapshotMeta | null>(null)
	const [lastAction, setLastAction] = useState<EditAction | null>(null)

	const watermark = useMemo(() => (items ? pickWatermark(items) : null), [items])
	const persistence = settings?.persistence
	const persistenceEnabled = !!persistence?.enabled

	const boot = useCallback(async (docIdOverride?: string) => {
		setBusy(true)
		try {
			const res = await hub.bootstrap()
			setSettings(res.settings)
			setItems(res.contributions)
			const nextDocId = docIdOverride ?? res.settings.persistence.docId ?? 'default'
			setActiveDocId(nextDocId)
			setError(null)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}, [hub])

	const refreshDocs = useCallback(async () => {
		try {
			const list = await hub.docs()
			setKnownDocs(list)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		}
	}, [hub])

	useEffect(() => {
		void boot()
	}, [boot])

	useEffect(() => {
		void refreshDocs()
	}, [refreshDocs])

	useEffect(() => {
		const api = univerApi
		if (!api) return
		applyTextWatermark(api, watermark)
	}, [univerApi, watermark])

	useEffect(() => {
		if (!container) return
		if (!settings) return

		const settingsKey = JSON.stringify(settings)
		const current = univerRef.current
		if (current && current.settingsKey === settingsKey) return
		if (current) {
			current.api.dispose()
			univerRef.current = null
			setUniverApi(null)
		}

		const api = createSheetsUniver({ container, settings })
		univerRef.current = { api, settingsKey }
		setUniverApi(api)
		return () => {
			univerRef.current = null
			setUniverApi(null)
			api.dispose()
		}
	}, [container, settings])

	const bootstrapDoc = useCallback(
		async (docId: string) => {
			const api = univerApi
			if (!api) return
			const normalized = docId.trim() || 'default'

			setBusy(true)
			appliedSeqRef.current = 0
			setAppliedSeq(0)
			try {
				// Rebuild semantics: always rebuild from the latest snapshot + patches since snapshot baseSeq.
				// `afterSeq` is only meaningful when you already have a local state at that seq.
				const boot = await hub.docBootstrap(normalized, 0, 1000)

				const current = api.getActiveWorkbook()
				const unitId = current?.getId()
				if (unitId) api.disposeUnit(unitId)

				if (boot.snapshot?.snapshot) api.createWorkbook(boot.snapshot.snapshot)
				else api.createWorkbook({})

				for (const p of boot.patches) {
					applySheetsPatch(api, p.patch)
					appliedSeqRef.current = p.seq
					setAppliedSeq(p.seq)
				}

				if (boot.patches.length === 0) {
					appliedSeqRef.current = boot.baseSeq
					setAppliedSeq(boot.baseSeq)
				}
				setSnapshotMeta(
					boot.snapshot?.snapshot ? { docId: boot.snapshot.docId, savedAt: boot.snapshot.savedAt } : null,
				)
				setError(null)
				void refreshDocs()
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			} finally {
				setBusy(false)
			}
		},
		[hub, refreshDocs, univerApi],
	)

	useEffect(() => {
		if (!univerApi) return
		if (!activeDocId.trim()) return
		void bootstrapDoc(activeDocId)
	}, [activeDocId, bootstrapDoc, univerApi])

	useEffect(() => {
		const api = univerApi
		if (!api) return
		const docId = activeDocId.trim() || 'default'

		const sse = ctx.services.hmr.createSse({
			namespaces: ['UniverSheetsHub'],
			params: { docId },
		})

		let queue = Promise.resolve()
		const enqueue = (fn: () => Promise<void> | void) => {
			queue = queue.then(() => fn()).catch((e) => {
				setError(e instanceof Error ? e.message : String(e))
			})
		}

		const catchup = async () => {
			const after = appliedSeqRef.current
			const list = await hub.patchesSince(docId, after, 1000)
			for (const p of list) {
				applySheetsPatch(api, p.patch)
				appliedSeqRef.current = p.seq
				setAppliedSeq(p.seq)
			}
		}

		const dispose = sse.UniverSheetsHub.onAny((msg) => {
			const payload = msg.payload
			if (!payload || typeof payload !== 'object') return

			if (payload.type === 'ready') {
				if (payload.docId !== docId) return
				if (payload.lastSeq > appliedSeqRef.current) enqueue(catchup)
				return
			}

			if (payload.type === 'patch') {
				if (payload.docId !== docId) return
				if (payload.sourceId && payload.sourceId === sourceIdRef.current) return

				const expected = appliedSeqRef.current + 1
				if (payload.seq !== expected) {
					enqueue(catchup)
					return
				}

				enqueue(() => {
					applySheetsPatch(api, payload.patch)
					appliedSeqRef.current = payload.seq
					setAppliedSeq(payload.seq)
				})
				return
			}

			if (payload.type === 'error') {
				setError(String(payload.message ?? 'SSE error'))
				return
			}
		})

		return () => {
			dispose()
			sse.close()
		}
	}, [activeDocId, ctx.services.hmr, hub, univerApi])

	const loadSnapshot = useCallback(async () => {
		if (!persistenceEnabled) return
		const api = univerApi
		if (!api) return
		const docId = activeDocId.trim() || 'default'

		setBusy(true)
		try {
			const file = (await hub.loadSnapshot(docId)) as SnapshotFile | null
			if (!file?.snapshot) return

			const current = api.getActiveWorkbook()
			const unitId = current?.getId()
			if (unitId) api.disposeUnit(unitId)

			api.createWorkbook(file.snapshot)
			setSnapshotMeta({ docId: file.docId, savedAt: file.savedAt })
			setError(null)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}, [activeDocId, hub, persistenceEnabled, univerApi])

	const saveSnapshot = useCallback(async () => {
		if (!persistenceEnabled) return
		const api = univerApi
		if (!api) return
		const docId = activeDocId.trim() || 'default'

		setBusy(true)
		try {
			const workbook = api.getActiveWorkbook()
			if (!workbook) return
				const snapshot = workbook.save()
				const res = await hub.saveSnapshot(docId, snapshot)
				setSnapshotMeta({ docId, savedAt: res.savedAt })
				setError(null)
				void refreshDocs()
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}, [activeDocId, hub, persistenceEnabled, refreshDocs, univerApi])

	const submitPatch = useCallback(
		async (spec: SheetsPatchSpec) => {
			const api = univerApi
			if (!api) return
			const docId = activeDocId.trim() || 'default'
			setBusy(true)
			try {
				const event = await hub.appendPatch(docId, spec, { sourceId: sourceIdRef.current })
				applySheetsPatch(api, spec)
				appliedSeqRef.current = event.seq
				setAppliedSeq(event.seq)
				setError(null)
				void refreshDocs()
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			} finally {
				setBusy(false)
			}
		},
		[activeDocId, hub, univerApi],
	)

	const run = useCallback(
		(kind: EditAction['kind']) => {
			const action: EditAction =
				kind === 'setValue'
					? { kind, a1, value }
					: kind === 'setFormula'
						? { kind, a1, formula }
						: kind === 'setValuesJson'
							? { kind, a1, json }
							: { kind, a1 }
			const range = normalizeA1(action.a1)
			if (action.kind === 'setValue') {
				void submitPatch({ actions: [{ op: 'set', range, value: action.value }] })
				setLastAction(action)
				return
			}
			if (action.kind === 'setFormula') {
				const raw = action.formula.trim()
				const next = raw.startsWith('=') ? raw : `=${raw}`
				void submitPatch({ actions: [{ op: 'set', range, value: next }] })
				setLastAction(action)
				return
			}
			if (action.kind === 'clear') {
				void submitPatch({ actions: [{ op: 'clear', range }] })
				setLastAction(action)
				return
			}
			if (action.kind === 'setValuesJson') {
				try {
					const parsed = JSON.parse(action.json) as unknown
					if (!Array.isArray(parsed)) throw new Error('JSON must be a 2D array, e.g. [[1,2],[3,4]]')
					if (!parsed.every((row) => Array.isArray(row)))
						throw new Error('JSON must be a 2D array, e.g. [[1,2],[3,4]]')
					const matrix = parsed as unknown[][]
					const hasObjectCell = matrix.some((row) =>
						row.some((cell) => typeof cell === 'object' && cell !== null && !Array.isArray(cell)),
					)
					void submitPatch({
						actions: [{ op: 'setValues', range, values: hasObjectCell ? (matrix as CellData2D) : (matrix as CellValues2D) }],
					})
					setLastAction(action)
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e))
				}
				return
			}
		},
		[a1, formula, json, submitPatch, value],
	)

	return (
		<div style={{ height: '100dvh', width: '100%', overflow: 'hidden', display: 'grid', gridTemplateColumns: '1fr 360px' }}>
			<div style={{ position: 'relative', overflow: 'hidden' }}>
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
			</div>

			<div
				style={{
					borderLeft: '1px solid rgba(0,0,0,0.08)',
					padding: 14,
					display: 'flex',
					flexDirection: 'column',
					gap: 12,
					background: 'linear-gradient(180deg, rgba(255,255,255,0.96), rgba(255,255,255,0.92))',
					backdropFilter: 'blur(10px)',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
					<div style={{ fontWeight: 650 }}>Sheets Studio</div>
					<a href="/" style={{ textDecoration: 'none', color: '#222' }}>
						← 宿主
					</a>
				</div>

				<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
					<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
						<div style={{ fontSize: 12, opacity: 0.75 }}>docId</div>
						<input
							value={activeDocId}
							onChange={(e) => setActiveDocId(e.currentTarget.value)}
							list="studio-doc-ids"
							placeholder="default"
							style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid rgba(0,0,0,0.12)' }}
						/>
						<datalist id="studio-doc-ids">
							{knownDocs.map((d) => (
								<option key={d.docId} value={d.docId} />
							))}
						</datalist>
						<div style={{ fontSize: 12, opacity: 0.65 }}>共 {knownDocs.length} 个</div>
					</div>

					<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
						<div style={{ fontSize: 12, opacity: 0.75 }}>range (A1 / A1:B2)</div>
						<input
							value={a1}
							onChange={(e) => setA1(e.currentTarget.value)}
							placeholder="A1"
							style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid rgba(0,0,0,0.12)' }}
						/>
					</div>
				</div>

				<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
					<button type="button" disabled={busy} onClick={() => void boot()} style={{ padding: '8px 10px', borderRadius: 10 }}>
						刷新(配置/贡献)
					</button>
					<button
						type="button"
						disabled={busy || !persistenceEnabled}
						onClick={() => void loadSnapshot()}
						style={{ padding: '8px 10px', borderRadius: 10 }}
					>
						加载快照
					</button>
					<button
						type="button"
						disabled={busy || !persistenceEnabled}
						onClick={() => void saveSnapshot()}
						style={{ padding: '8px 10px', borderRadius: 10 }}
					>
						保存快照
					</button>
				</div>

				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					<div style={{ fontSize: 12, opacity: 0.75 }}>setValue</div>
					<input
						value={value}
						onChange={(e) => setValue(e.currentTarget.value)}
						placeholder="Hello"
						style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid rgba(0,0,0,0.12)' }}
					/>
					<button type="button" onClick={() => run('setValue')} disabled={!univerApi} style={{ padding: '8px 10px', borderRadius: 10 }}>
						应用到 range
					</button>
				</div>

				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					<div style={{ fontSize: 12, opacity: 0.75 }}>setFormula</div>
					<input
						value={formula}
						onChange={(e) => setFormula(e.currentTarget.value)}
						placeholder="=SUM(1,2,3)"
						style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid rgba(0,0,0,0.12)' }}
					/>
					<button type="button" onClick={() => run('setFormula')} disabled={!univerApi} style={{ padding: '8px 10px', borderRadius: 10 }}>
						应用公式
					</button>
				</div>

				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					<div style={{ fontSize: 12, opacity: 0.75 }}>setValues (JSON 2D array)</div>
					<textarea
						value={json}
						onChange={(e) => setJson(e.currentTarget.value)}
						rows={4}
						spellCheck={false}
						style={{
							padding: '8px 10px',
							borderRadius: 10,
							border: '1px solid rgba(0,0,0,0.12)',
							fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
							fontSize: 12,
						}}
					/>
					<button type="button" onClick={() => run('setValuesJson')} disabled={!univerApi} style={{ padding: '8px 10px', borderRadius: 10 }}>
						批量写入
					</button>
				</div>

				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					<div style={{ fontSize: 12, opacity: 0.75 }}>Patch (LLM-friendly JSON)</div>
					<textarea
						value={patch}
						onChange={(e) => setPatch(e.currentTarget.value)}
						rows={7}
						spellCheck={false}
						style={{
							padding: '8px 10px',
							borderRadius: 10,
							border: '1px solid rgba(0,0,0,0.12)',
							fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
							fontSize: 12,
						}}
					/>
						<button
							type="button"
							onClick={() => {
								try {
									const parsed = parseSheetsPatchSpecFromJson(patch)
									void submitPatch(parsed)
								} catch (e) {
									setError(e instanceof Error ? e.message : String(e))
								}
						}}
						disabled={!univerApi}
						style={{ padding: '8px 10px', borderRadius: 10 }}
					>
						应用 Patch
					</button>
				</div>

				<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
					<button type="button" onClick={() => run('clear')} disabled={!univerApi} style={{ padding: '8px 10px', borderRadius: 10 }}>
						清空 range
					</button>
				</div>

					<div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.35 }}>
						<div>水印：{watermark ? '启用' : '关闭'}</div>
						<div>持久化：{persistenceEnabled ? '启用' : '关闭'}</div>
						<div>快照：{snapshotMeta ? new Date(snapshotMeta.savedAt).toLocaleString() : '无'}</div>
						<div>增量 seq：{appliedSeq}</div>
						{lastAction ? <div>最后操作：{lastAction.kind} @ {normalizeA1(lastAction.a1)}</div> : null}
					</div>

				{error ? (
					<div style={{ color: '#c92a2a', fontSize: 12, whiteSpace: 'pre-wrap' }}>错误：{error}</div>
				) : null}
			</div>
		</div>
	)
}
