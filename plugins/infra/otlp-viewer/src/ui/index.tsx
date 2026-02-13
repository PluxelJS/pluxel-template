import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Code,
	Drawer,
	Divider,
	Group,
	Loader,
	Pagination,
	Paper,
	ScrollArea,
	SegmentedControl,
	SimpleGrid,
	Stack,
	Switch,
	Table,
	Text,
	Textarea,
	TextInput,
	Title,
} from '@mantine/core'
import { IconArrowLeft, IconCopy, IconExternalLink, IconRefresh, IconSearch, IconTerminal2, IconX } from '@tabler/icons-react'

import './runtime'
import { definePluginUIModule, rpcErrorMessage, useExtensionContext } from '@pluxel/hmr/web'
import type { PluginExtensionContext } from '@pluxel/hmr/web'

type Rpc = PluginExtensionContext['services']['hmr']['ui']['OtlpViewer']

function useRpc(): Rpc {
	const { services } = useExtensionContext('plugin')
	return useMemo(() => services.hmr.ui.OtlpViewer, [services])
}

function useDebounced<T>(value: T, delayMs: number): T {
	const [v, setV] = useState(value)
	useEffect(() => {
		const t = setTimeout(() => setV(value), Math.max(0, Math.floor(delayMs)))
		return () => clearTimeout(t)
	}, [value, delayMs])
	return v
}

function parseDatetimeLocalToMs(v: string): number | undefined {
	const s = String(v ?? '').trim()
	if (!s) return undefined
	const m = s.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/,
	)
	if (!m) {
		const ms = Date.parse(s)
		return Number.isFinite(ms) ? ms : undefined
	}
	const year = Number(m[1])
	const month = Number(m[2])
	const day = Number(m[3])
	const hour = Number(m[4])
	const minute = Number(m[5])
	const second = Number(m[6] ?? 0)
	const msPart = Number(String(m[7] ?? '0').padEnd(3, '0'))
	const ts = new Date(year, month - 1, day, hour, minute, second, msPart).getTime()
	return Number.isFinite(ts) ? ts : undefined
}

function formatMs(v: unknown): string {
	const n = Number(v)
	if (!Number.isFinite(n) || n <= 0) return ''
	try {
		return new Date(n).toLocaleString()
	} catch {
		return String(n)
	}
}

function shortText(value: unknown, max = 140): string {
	const s = String(value ?? '')
	if (s.length <= max) return s
	return `${s.slice(0, max)}…`
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		try {
			return JSON.stringify(String(value))
		} catch {
			return String(value)
		}
	}
}

async function copyText(text: string): Promise<void> {
	const s = String(text ?? '')
	if (!s) return
	try {
		if (navigator?.clipboard?.writeText) {
			await navigator.clipboard.writeText(s)
			return
		}
	} catch {
		// fall back
	}
	const el = document.createElement('textarea')
	el.value = s
	el.style.position = 'fixed'
	el.style.left = '-9999px'
	el.style.top = '0'
	document.body.appendChild(el)
	el.select()
	try {
		document.execCommand('copy')
	} finally {
		document.body.removeChild(el)
	}
}

function RowDrawer({
	open,
	onClose,
	title,
	row,
	onCopy,
	onFilterCallerId,
	onFilterQ,
	onFilterName,
	onOpenTrace,
	onAddFilter,
}: {
	open: boolean
	onClose: () => void
	title: string
	row: Record<string, any> | null
	onCopy: (text: string, label?: string) => void
	onFilterCallerId: (callerId: string) => void
	onFilterQ: (q: string) => void
	onFilterName: (name: string) => void
	onOpenTrace: (traceId: string) => void
	onAddFilter: (f: { field: string; op: string; value?: string }) => void
}) {
	const text = useMemo(() => {
		if (!row) return ''
		try {
			return JSON.stringify(row, null, 2)
		} catch {
			return String(row)
		}
	}, [row])

	const callerId = String((row as any)?.caller_id ?? '').trim()
	const traceId = String((row as any)?.trace_id ?? '').trim()
	const spanId = String((row as any)?.span_id ?? '').trim()
	const name = String((row as any)?.name ?? '').trim()
	const attributesJson = String((row as any)?.attributes_json ?? '').trim()
	const eventsJson = String((row as any)?.events_json ?? '').trim()
	const errorJson = String((row as any)?.error_json ?? '').trim()

	const parsedAttributes = useMemo(() => {
		if (!attributesJson) return null
		try {
			const v = JSON.parse(attributesJson)
			return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null
		} catch {
			return null
		}
	}, [attributesJson])

	const parsedEvents = useMemo(() => {
		if (!eventsJson) return null
		try {
			const v = JSON.parse(eventsJson)
			return Array.isArray(v) ? (v as any[]) : null
		} catch {
			return null
		}
	}, [eventsJson])

	const parsedError = useMemo(() => {
		if (!errorJson) return null
		try {
			const v = JSON.parse(errorJson)
			return v && typeof v === 'object' ? v : null
		} catch {
			return null
		}
	}, [errorJson])

	const attributeEntries = useMemo(() => {
		if (!parsedAttributes) return []
		return Object.entries(parsedAttributes).sort(([a], [b]) => a.localeCompare(b))
	}, [parsedAttributes])

	return (
		<Drawer opened={open} onClose={onClose} position="right" size="lg" title={title}>
			<Group gap="xs" mb="sm" wrap="wrap">
				<Button size="xs" variant="light" onClick={() => onCopy(text, 'JSON')}>
					Copy JSON
				</Button>
				{callerId ? (
					<>
						<Button size="xs" variant="light" onClick={() => onCopy(callerId, 'callerId')}>
							Copy callerId
						</Button>
						<Button size="xs" variant="subtle" onClick={() => onFilterCallerId(callerId)}>
							Filter callerId
						</Button>
					</>
				) : null}
				{traceId ? (
					<>
						<Button size="xs" variant="light" onClick={() => onCopy(traceId, 'traceId')}>
							Copy traceId
						</Button>
						<Button size="xs" variant="light" onClick={() => onOpenTrace(traceId)}>
							Open trace
						</Button>
						<Button size="xs" variant="subtle" onClick={() => onFilterQ(traceId)}>
							Filter traceId
						</Button>
					</>
				) : null}
				{spanId ? (
					<Button size="xs" variant="light" onClick={() => onCopy(spanId, 'spanId')}>
						Copy spanId
					</Button>
				) : null}
				{name ? (
					<Button size="xs" variant="subtle" onClick={() => onFilterName(name)}>
						Filter name
					</Button>
				) : null}
			</Group>

			<ScrollArea h="calc(100vh - 170px)">
				<Stack gap="sm">
					{parsedError ? (
						<>
							<Title order={5}>Error</Title>
							<Code block style={{ whiteSpace: 'pre-wrap' }}>
								{safeStringify(parsedError)}
							</Code>
							<Divider />
						</>
					) : null}

					{attributeEntries.length ? (
						<>
							<Group justify="space-between" wrap="nowrap">
								<Title order={5}>Attributes</Title>
								<Button size="xs" variant="subtle" leftSection={<IconCopy size={14} />} onClick={() => onCopy(attributesJson, 'attributes')}>
									Copy
								</Button>
							</Group>
							<Table withTableBorder verticalSpacing="xs" horizontalSpacing="xs">
								<Table.Thead>
									<Table.Tr>
										<Table.Th>key</Table.Th>
										<Table.Th>value</Table.Th>
									</Table.Tr>
								</Table.Thead>
								<Table.Tbody>
									{attributeEntries.map(([k, v]) => (
										<Table.Tr key={k}>
											<Table.Td>
												<Group gap="xs" wrap="nowrap">
													<Code>{k}</Code>
														<ActionIcon
															size="xs"
															variant="subtle"
															aria-label="filter attr exists"
															onClick={() => onAddFilter({ field: `attr.${k}`, op: 'exists' })}
														>
															<IconSearch size={14} />
														</ActionIcon>
												</Group>
											</Table.Td>
											<Table.Td>
													<Group gap="xs" wrap="nowrap" align="flex-start">
														<Text size="xs" style={{ wordBreak: 'break-word', flex: 1 }}>
															{typeof v === 'string' ? v : safeStringify(v)}
														</Text>
														{v === null || v === undefined || typeof v === 'object' ? null : (
															<ActionIcon
																size="xs"
																variant="subtle"
																aria-label="filter attr equals"
																onClick={() => onAddFilter({ field: `attr.${k}`, op: 'eq', value: String(v) })}
															>
																<IconSearch size={14} />
															</ActionIcon>
														)}
													</Group>
											</Table.Td>
										</Table.Tr>
									))}
								</Table.Tbody>
							</Table>
							<Divider />
						</>
					) : null}

					{parsedEvents?.length ? (
						<>
							<Group justify="space-between" wrap="nowrap">
								<Title order={5}>Events</Title>
								<Button size="xs" variant="subtle" leftSection={<IconCopy size={14} />} onClick={() => onCopy(eventsJson, 'events')}>
									Copy
								</Button>
							</Group>
							<Table withTableBorder verticalSpacing="xs" horizontalSpacing="xs">
								<Table.Thead>
									<Table.Tr>
										<Table.Th>time</Table.Th>
										<Table.Th>name</Table.Th>
										<Table.Th>attrs</Table.Th>
									</Table.Tr>
								</Table.Thead>
								<Table.Tbody>
									{parsedEvents.slice(0, 200).map((e: any, i: number) => (
										<Table.Tr key={i}>
											<Table.Td>
												{formatMs(typeof e?.tsMs === 'number' ? e.tsMs : typeof e?.ts_ms === 'number' ? e.ts_ms : '')}
											</Table.Td>
											<Table.Td>{String(e?.name ?? '')}</Table.Td>
											<Table.Td>
													<Text size="xs" style={{ wordBreak: 'break-word' }}>
														{e?.attributes ? safeStringify(e.attributes) : ''}
													</Text>
											</Table.Td>
										</Table.Tr>
									))}
								</Table.Tbody>
							</Table>
							<Divider />
						</>
					) : null}

					<Group justify="space-between" wrap="nowrap">
						<Title order={5}>Raw</Title>
						<Button size="xs" variant="subtle" leftSection={<IconCopy size={14} />} onClick={() => onCopy(text, 'raw')}>
							Copy
						</Button>
					</Group>
					<Code block style={{ whiteSpace: 'pre-wrap' }}>
						{text}
					</Code>
				</Stack>
			</ScrollArea>
		</Drawer>
	)
}

type Signal = 'logs' | 'traces' | 'metrics' | 'sql'

function shortId(id: unknown, left = 8, right = 6): string {
	const s = String(id ?? '')
	if (s.length <= left + right + 1) return s
	return `${s.slice(0, left)}…${s.slice(-right)}`
}

function OtlpViewerPage() {
	const rpc = useRpc()

	const [signal, setSignal] = useState<Signal>('logs')
	const [selectedTraceId, setSelectedTraceId] = useState<string>('')
	const [traceDetail, setTraceDetail] = useState<any | null>(null)
	const [traceLoading, setTraceLoading] = useState(false)
	const [traceError, setTraceError] = useState<string | null>(null)

	const [q, setQ] = useState('')
	const qDebounced = useDebounced(q, 250)

	const [callerId, setCallerId] = useState('')
	const callerIdDebounced = useDebounced(callerId, 250)

	const [level, setLevel] = useState('')
	const [status, setStatus] = useState('')
	const [name, setName] = useState('')
	const nameDebounced = useDebounced(name, 250)
	const [metricType, setMetricType] = useState('')

	const [filters, setFilters] = useState<Array<{ field: string; op: string; value?: string }>>([])
	const [filterField, setFilterField] = useState('')
	const [filterOp, setFilterOp] = useState<'eq' | 'neq' | 'contains' | 'like' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte'>('eq')
	const [filterValue, setFilterValue] = useState('')

	const [facetScanRows, setFacetScanRows] = useState(20_000)
	const [facetKeyQ, setFacetKeyQ] = useState('')
	const facetKeyQDebounced = useDebounced(facetKeyQ, 200)
	const [facetKeys, setFacetKeys] = useState<Array<{ key: string; n: number }>>([])
	const [facetKeysLoading, setFacetKeysLoading] = useState(false)
	const [facetKeysError, setFacetKeysError] = useState<string | null>(null)
	const [facetSelectedKey, setFacetSelectedKey] = useState('')
	const [facetValues, setFacetValues] = useState<Array<{ value: string; type: string; n: number }>>([])
	const [facetValuesLoading, setFacetValuesLoading] = useState(false)
	const [facetValuesError, setFacetValuesError] = useState<string | null>(null)

	const [fromLocal, setFromLocal] = useState('')
	const [toLocal, setToLocal] = useState('')
	const fromTsMs = useMemo(() => parseDatetimeLocalToMs(fromLocal), [fromLocal])
	const toTsMs = useMemo(() => parseDatetimeLocalToMs(toLocal), [toLocal])

	const [pageSize, setPageSize] = useState(200)
	const [page, setPage] = useState(1)

	const [live, setLive] = useState(false)
	const [seedCount, setSeedCount] = useState(50)
	const [actionMsg, setActionMsg] = useState<string | null>(null)
	const [filtersOpen, setFiltersOpen] = useState(false)

	const [stats, setStats] = useState<any | null>(null)
	const [loadingStats, setLoadingStats] = useState(true)
	const [statsError, setStatsError] = useState<string | null>(null)

	const [rows, setRows] = useState<Record<string, any>[]>([])
	const [total, setTotal] = useState(0)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const [selected, setSelected] = useState<Record<string, any> | null>(null)
	const [drawerOpen, setDrawerOpen] = useState(false)

	const sqlRef = useRef<HTMLTextAreaElement | null>(null)
	const [sql, setSql] = useState('select count(*) as logs from otlp_logs;')
	const [sqlLoading, setSqlLoading] = useState(false)
	const [sqlError, setSqlError] = useState<string | null>(null)
	const [sqlResult, setSqlResult] = useState<{ columns: string[]; rows: Record<string, any>[] } | null>(null)

	const totalPages = useMemo(() => Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize))), [total, pageSize])
	const offset = useMemo(() => Math.max(0, (Math.max(1, page) - 1) * Math.max(1, pageSize)), [page, pageSize])

	const filterFieldSuggestions = useMemo(() => {
		const common = [
			'attr.service.name',
			'attr.service.namespace',
			'attr.service.version',
			'attr.otel.tracer.name',
			'attr.otel.scope.name',
			'attr.otel.scope.version',
			'attr.pluxel.caller.id',
			'attr.pluxel.caller.name',
			'attr.pluxel.provider.id',
			'attr.pluxel.provider.name',
			'attr.http.request.method',
			'attr.http.route',
			'attr.http.target',
			'attr.http.response.status_code',
			'attr.url.full',
			'attr.rpc.system',
			'attr.db.system',
			'attr.llm.client',
			'attr.llm.provider',
			'attr.llm.model',
			'attr.llm.profile_id',
			'attr.llm.upstream.request_id',
			'attr.ax.flow',
			'attr.ax.purpose',
			'attr.univer.run_id',
			'attr.univer.workbook_id',
		]
		if (signal === 'logs') return ['level', 'callerId', 'traceId', 'spanId', ...common]
		if (signal === 'traces') return ['status', 'kind', 'name', 'callerId', 'traceId', 'spanId', 'parentSpanId', ...common]
		if (signal === 'metrics') return ['type', 'name', 'callerId', 'value', ...common]
		return common
	}, [signal])

	const facetSignal = useMemo(() => {
		if (signal === 'logs') return 'logs'
		if (signal === 'metrics') return 'metrics'
		return 'traces'
	}, [signal])

	const facetOpts = useMemo(() => {
		const scopedFilters =
			signal === 'traces' && selectedTraceId ? [...filters, { field: 'traceId', op: 'eq', value: selectedTraceId }] : filters
		const extra: Record<string, unknown> = {}
		if (facetSignal === 'logs') extra.level = level
		if (facetSignal === 'traces') {
			extra.status = status
			extra.name = nameDebounced
		}
		if (facetSignal === 'metrics') {
			extra.metricType = metricType
			extra.name = nameDebounced
		}
		return {
			q: qDebounced,
			callerId: callerIdDebounced,
			fromTsMs,
			toTsMs,
			filters: scopedFilters,
			...(extra as any),
		}
	}, [facetSignal, qDebounced, callerIdDebounced, fromTsMs, toTsMs, filters, level, status, nameDebounced, metricType, signal, selectedTraceId])

	const flash = useCallback((message: string) => {
		setActionMsg(message)
		const t = setTimeout(() => setActionMsg(null), 3500)
		return () => clearTimeout(t)
	}, [])

	const addFilter = useCallback(
		(f: { field: string; op: string; value?: string }) => {
			const field = String(f.field ?? '').trim()
			const op = String(f.op ?? '').trim()
			const value = f.value === undefined ? undefined : String(f.value)
			if (!field || !op) return
			setFilters((prev) => {
				const next = prev.slice()
				if (next.length >= 50) return next
				next.push({ field, op, ...(value !== undefined ? { value } : {}) })
				return next
			})
			flash(`Filter added: ${field}`)
		},
		[flash],
	)

	const onCopy = useCallback(
		(text: string, label?: string) => {
			void copyText(text).then(
				() => flash(label ? `Copied ${label}` : 'Copied'),
				() => flash('Copy failed'),
			)
		},
		[flash],
	)

	const openTrace = useCallback(
		(traceId: string) => {
			const id = String(traceId ?? '').trim()
			if (!id) return
			setSignal('traces')
			setSelectedTraceId(id)
			try {
				const u = new URL(window.location.href)
				u.searchParams.set('signal', 'traces')
				u.searchParams.set('traceId', id)
				window.history.replaceState({}, '', u.toString())
			} catch {
				// ignore
			}
		},
		[setSignal],
	)

	const closeTrace = useCallback(() => {
		setSelectedTraceId('')
		setTraceDetail(null)
		setTraceError(null)
		try {
			const u = new URL(window.location.href)
			u.searchParams.delete('traceId')
			window.history.replaceState({}, '', u.toString())
		} catch {
			// ignore
		}
	}, [])

	const refreshStats = useCallback(async () => {
		setLoadingStats(true)
		try {
			const s = await rpc.storeStats()
			setStats(s)
			setStatsError(null)
		} catch (err) {
			setStatsError(rpcErrorMessage(err, '无法读取 OTLP store 状态'))
		} finally {
			setLoadingStats(false)
		}
	}, [rpc])

	const refreshFacetKeys = useCallback(async () => {
		if (!filtersOpen) return
		if (signal === 'sql') return
		setFacetKeysLoading(true)
		try {
			const out = await rpc.facetKeys(facetSignal as any, facetOpts as any, { scanRows: facetScanRows, limitKeys: 200 })
			setFacetKeys(out.keys ?? [])
			setFacetKeysError(null)
		} catch (err) {
			setFacetKeysError(rpcErrorMessage(err, '无法加载 attribute keys'))
			setFacetKeys([])
		} finally {
			setFacetKeysLoading(false)
		}
	}, [filtersOpen, rpc, signal, facetSignal, facetOpts, facetScanRows])

	const refreshFacetValues = useCallback(
		async (key: string) => {
			if (!filtersOpen) return
			const k = String(key ?? '').trim()
			if (!k) return
			if (signal === 'sql') return
			setFacetValuesLoading(true)
			try {
				const out = await rpc.facetValues(facetSignal as any, k, facetOpts as any, { scanRows: facetScanRows, limitValues: 200 })
				setFacetSelectedKey(out.key ?? k)
				setFacetValues(out.values ?? [])
				setFacetValuesError(null)
			} catch (err) {
				setFacetValuesError(rpcErrorMessage(err, '无法加载 attribute values'))
				setFacetValues([])
			} finally {
				setFacetValuesLoading(false)
			}
		},
		[filtersOpen, rpc, signal, facetSignal, facetOpts, facetScanRows],
	)

	const refreshList = useCallback(async () => {
		if (signal === 'sql') return
		if (signal === 'traces' && selectedTraceId) return
		setLoading(true)
		try {
			const extra: Record<string, unknown> = {}
			if (signal === 'logs') extra.level = level
			if (signal === 'traces') {
				extra.status = status
				extra.name = nameDebounced
			}
			if (signal === 'metrics') {
				extra.metricType = metricType
				extra.name = nameDebounced
			}
			if (signal === 'traces') {
				const out = await rpc.listTraces({
					q: qDebounced,
					callerId: callerIdDebounced,
					fromTsMs,
					toTsMs,
					limit: pageSize,
					offset,
					filters,
					...(extra as any),
				} as any)
				setRows(out.rows as any)
				setTotal(out.total)
			} else {
				const out = await rpc.list(signal as any, {
					q: qDebounced,
					callerId: callerIdDebounced,
					fromTsMs,
					toTsMs,
					limit: pageSize,
					offset,
					filters,
					...(extra as any),
				})
				setRows(out.rows as any)
				setTotal(out.total)
			}
			setError(null)
		} catch (err) {
			setError(rpcErrorMessage(err, `无法加载 ${signal}`))
		} finally {
			setLoading(false)
		}
	}, [rpc, signal, selectedTraceId, qDebounced, callerIdDebounced, fromTsMs, toTsMs, pageSize, offset, level, status, nameDebounced, metricType, filters])

	const refreshTraceDetail = useCallback(async () => {
		const id = String(selectedTraceId ?? '').trim()
		if (!id) return
		setTraceLoading(true)
		try {
			const out = await rpc.getTrace(id)
			setTraceDetail(out as any)
			setTraceError(null)
		} catch (err) {
			setTraceError(rpcErrorMessage(err, '无法加载 trace 详情'))
			setTraceDetail(null)
		} finally {
			setTraceLoading(false)
		}
	}, [rpc, selectedTraceId])

	const runSql = useCallback(async () => {
		setSqlLoading(true)
		try {
			const out = await rpc.query(sql)
			setSqlResult(out as any)
			setSqlError(null)
		} catch (err) {
			setSqlError(rpcErrorMessage(err, 'SQL 查询失败'))
		} finally {
			setSqlLoading(false)
		}
	}, [rpc, sql])

	useEffect(() => {
		try {
			const u = new URL(window.location.href)
			const sig = String(u.searchParams.get('signal') ?? '').trim()
			if (sig === 'logs' || sig === 'traces' || sig === 'metrics' || sig === 'sql') setSignal(sig)
			const traceId = String(u.searchParams.get('traceId') ?? '').trim()
			if (traceId) setSelectedTraceId(traceId)
		} catch {
			// ignore
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	useEffect(() => {
		void refreshStats()
	}, [refreshStats])

	useEffect(() => {
		setPage(1)
	}, [signal, qDebounced, callerIdDebounced, fromTsMs, toTsMs, pageSize, level, status, nameDebounced, metricType, filters])

	useEffect(() => {
		if (signal !== 'traces' && selectedTraceId) closeTrace()
	}, [closeTrace, selectedTraceId, signal])

	useEffect(() => {
		void refreshList()
	}, [refreshList])

	useEffect(() => {
		if (!filtersOpen) return
		if (signal === 'sql') return
		const t = setTimeout(() => {
			void refreshFacetKeys()
		}, 350)
		return () => clearTimeout(t)
	}, [filtersOpen, signal, facetSignal, facetOpts, facetScanRows, refreshFacetKeys])

	useEffect(() => {
		if (!filtersOpen) return
		if (!facetSelectedKey) return
		const t = setTimeout(() => {
			void refreshFacetValues(facetSelectedKey)
		}, 350)
		return () => clearTimeout(t)
	}, [filtersOpen, facetSelectedKey, facetSignal, facetOpts, facetScanRows, refreshFacetValues])

	useEffect(() => {
		if (signal !== 'traces') return
		if (!selectedTraceId) {
			setTraceDetail(null)
			setTraceError(null)
			return
		}
		void refreshTraceDetail()
	}, [signal, selectedTraceId, refreshTraceDetail])

	useEffect(() => {
		if (!live) return
		const t = setInterval(() => {
			void refreshStats()
			if (signal === 'traces' && selectedTraceId) void refreshTraceDetail()
			else if (signal !== 'sql') void refreshList()
		}, 1000)
		return () => clearInterval(t)
	}, [live, refreshList, refreshStats, refreshTraceDetail, signal, selectedTraceId])

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === '/' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
				e.preventDefault()
				const el = document.getElementById('otlp-search')
				;(el as any)?.focus?.()
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
				e.preventDefault()
				void refreshList()
				void refreshStats()
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
				e.preventDefault()
				setQ('')
				setCallerId('')
				setLevel('')
				setStatus('')
				setName('')
				setMetricType('')
				setFilters([])
			}
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [refreshList, refreshStats])

	const openRow = useCallback(
		(row: Record<string, any>) => {
			if (signal === 'traces') {
				openTrace(String((row as any).trace_id ?? ''))
				return
			}
			setSelected(row)
			setDrawerOpen(true)
		},
		[openTrace, signal],
	)

	const header = (
		<Paper withBorder p="xs" radius="md">
			<Group justify="space-between" align="center" wrap="wrap" gap="xs">
				<Group gap="xs" wrap="wrap">
					<Title order={5}>OTLP</Title>
					{loadingStats && !stats ? <Loader size="xs" /> : null}
					<Badge variant="light" color={stats?.enabled ? 'teal' : 'gray'}>
						{stats?.enabled ? 'capture' : 'disabled'}
					</Badge>
					<Badge variant="light" color="gray">
						<Code>{stats?.dbPath ?? ':memory:'}</Code>
					</Badge>
					{actionMsg ? (
						<Badge variant="light" color="teal">
							{actionMsg}
						</Badge>
					) : null}
					{stats?.lastError?.message ? (
						<Badge variant="light" color="red">
							{shortText(stats.lastError.message, 70)}
						</Badge>
					) : null}
				</Group>

				<Group gap="xs" wrap="wrap">
					<Switch size="xs" checked={live} onChange={(e) => setLive(e.currentTarget.checked)} label="Live" />
					<ActionIcon
						variant="light"
						aria-label="refresh"
						onClick={() => {
							void refreshStats()
							void refreshList()
						}}
					>
						<IconRefresh size={16} />
					</ActionIcon>
					<Button size="xs" variant="light" onClick={() => setFiltersOpen(true)}>
						Filters{filters.length ? ` (${filters.length})` : ''}
					</Button>
				</Group>
			</Group>

			{statsError ? (
				<Text size="xs" c="red" mt={6}>
					{statsError}
				</Text>
			) : null}

			<Divider my="xs" />

			<Group gap="xs" wrap="wrap">
				<SegmentedControl
					size="xs"
					value={signal}
					onChange={(v) => setSignal(v as Signal)}
					data={[
						{ value: 'logs', label: 'Logs' },
						{ value: 'traces', label: 'Traces' },
						{ value: 'metrics', label: 'Metrics' },
						{ value: 'sql', label: 'SQL' },
					]}
				/>
				<SegmentedControl
					size="xs"
					value={String(pageSize)}
					onChange={(v) => setPageSize(Number(v) || 200)}
					data={[
						{ value: '50', label: '50' },
						{ value: '200', label: '200' },
						{ value: '500', label: '500' },
					]}
				/>
				<TextInput
					id="otlp-search"
					size="xs"
					w={280}
					placeholder="q ( / to focus )"
					leftSection={<IconSearch size={14} />}
					value={q}
					onChange={(e) => setQ(e.currentTarget.value)}
				/>
				<TextInput size="xs" w={200} placeholder="callerId" value={callerId} onChange={(e) => setCallerId(e.currentTarget.value)} />
				<TextInput size="xs" w={210} type="datetime-local" placeholder="From" value={fromLocal} onChange={(e) => setFromLocal(e.currentTarget.value)} />
				<TextInput size="xs" w={210} type="datetime-local" placeholder="To" value={toLocal} onChange={(e) => setToLocal(e.currentTarget.value)} />

				{signal === 'logs' ? (
					<SegmentedControl
						size="xs"
						value={level || 'all'}
						onChange={(v) => setLevel(v === 'all' ? '' : v)}
						data={[
							{ value: 'all', label: 'All' },
							{ value: 'debug', label: 'Debug' },
							{ value: 'info', label: 'Info' },
							{ value: 'warn', label: 'Warn' },
							{ value: 'error', label: 'Error' },
						]}
					/>
				) : null}
				{signal === 'traces' ? (
					<>
						<SegmentedControl
							size="xs"
							value={status || 'all'}
							onChange={(v) => setStatus(v === 'all' ? '' : v)}
							data={[
								{ value: 'all', label: 'All' },
								{ value: 'ok', label: 'OK' },
								{ value: 'error', label: 'Error' },
							]}
						/>
						<TextInput size="xs" w={220} placeholder="name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
					</>
				) : null}
				{signal === 'metrics' ? (
					<>
						<SegmentedControl
							size="xs"
							value={metricType || 'all'}
							onChange={(v) => setMetricType(v === 'all' ? '' : v)}
							data={[
								{ value: 'all', label: 'All' },
								{ value: 'counter', label: 'Counter' },
								{ value: 'gauge', label: 'Gauge' },
								{ value: 'histogram', label: 'Hist' },
							]}
						/>
						<TextInput size="xs" w={220} placeholder="name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
					</>
				) : null}

				<Text size="xs" c="dimmed">
					<Code>/</Code> focus · <Code>Ctrl/Cmd+R</Code> refresh · <Code>Ctrl/Cmd+K</Code> clear
				</Text>
			</Group>
		</Paper>
	)

	const listColumns = useMemo(() => {
		if (signal === 'logs')
			return [
				{ key: 'ts_ms', label: 'time', render: (r: any) => formatMs(r.ts_ms) },
				{ key: 'level', label: 'level', render: (r: any) => String(r.level ?? '') },
				{
					key: 'trace_id',
					label: 'traceId',
					render: (r: any) => {
						const id = String(r.trace_id ?? '').trim()
						return id ? (
								<Text
									size="xs"
									onClick={(e) => {
										e.stopPropagation()
										openTrace(id)
									}}
									style={{ cursor: 'pointer' }}
								>
									{shortId(id)}
								</Text>
							) : (
								<Text size="xs" c="dimmed">
									-
								</Text>
							)
						},
					},
				{
					key: 'caller_id',
					label: 'caller',
						render: (r: any) => (
							<Text
								size="xs"
								onClick={(e) => {
									e.stopPropagation()
									setCallerId(String(r.caller_id ?? ''))
								}}
								style={{ cursor: 'pointer' }}
							>
								{String(r.caller_id ?? '')}
							</Text>
						),
					},
				{ key: 'body_text', label: 'body', render: (r: any) => shortText(r.body_text, 220) },
			]
		if (signal === 'traces')
			return [
				{ key: 'start_ts_ms', label: 'start', render: (r: any) => formatMs(r.start_ts_ms) },
				{ key: 'duration_ms', label: 'dur(ms)', render: (r: any) => String(Math.round(Number(r.duration_ms ?? 0))) },
				{ key: 'spans', label: 'spans', render: (r: any) => String(r.spans ?? '') },
				{
					key: 'errors',
					label: 'errors',
					render: (r: any) => {
						const n = Number(r.errors ?? 0)
							return n > 0 ? (
								<Badge variant="light" color="red">
									{n}
								</Badge>
							) : (
								<Text size="xs" c="dimmed">
									0
								</Text>
							)
						},
					},
				{ key: 'service_name', label: 'service', render: (r: any) => shortText(r.service_name ?? '', 40) },
				{ key: 'root_name', label: 'root', render: (r: any) => shortText(r.root_name, 140) },
				{
					key: 'trace_id',
					label: 'traceId',
						render: (r: any) => (
							<Text
								size="xs"
								onClick={(e) => {
									e.stopPropagation()
									openTrace(String(r.trace_id ?? ''))
								}}
								style={{ cursor: 'pointer' }}
							>
								{shortId(r.trace_id)}
							</Text>
						),
					},
			]
		if (signal === 'metrics')
			return [
				{ key: 'ts_ms', label: 'time', render: (r: any) => formatMs(r.ts_ms) },
				{ key: 'type', label: 'type', render: (r: any) => String(r.type ?? '') },
				{
					key: 'name',
					label: 'name',
						render: (r: any) => (
							<Text
								size="xs"
								onClick={(e) => {
									e.stopPropagation()
									setName(String(r.name ?? ''))
								}}
								style={{ cursor: 'pointer' }}
							>
								{shortText(r.name, 160)}
							</Text>
						),
					},
				{ key: 'value', label: 'value', render: (r: any) => String(r.value ?? '') },
				{
					key: 'caller_id',
					label: 'caller',
						render: (r: any) => (
							<Text
								size="xs"
								onClick={(e) => {
									e.stopPropagation()
									setCallerId(String(r.caller_id ?? ''))
								}}
								style={{ cursor: 'pointer' }}
							>
								{String(r.caller_id ?? '')}
							</Text>
						),
					},
			]
		return []
	}, [signal, openTrace, setCallerId, setName])

	const traceSpans = useMemo(() => {
		const rows0 = Array.isArray((traceDetail as any)?.rows) ? ((traceDetail as any).rows as any[]) : []
		const rows = rows0.filter((r) => r && typeof r === 'object')
		const nodes = new Map<string, any>()
		const children = new Map<string, any[]>()
		const roots: any[] = []

		for (const r of rows) {
			const sid = String((r as any).span_id ?? '').trim()
			if (!sid) continue
			nodes.set(sid, r)
		}
		for (const r of rows) {
			const sid = String((r as any).span_id ?? '').trim()
			if (!sid) continue
			const pid = String((r as any).parent_span_id ?? '').trim()
			if (pid && nodes.has(pid)) {
				const list = children.get(pid) ?? []
				list.push(r)
				children.set(pid, list)
			} else {
				roots.push(r)
			}
		}

		const sortByTime = (a: any, b: any) => Number(a?.start_ts_ms ?? 0) - Number(b?.start_ts_ms ?? 0) || Number(a?.seq ?? 0) - Number(b?.seq ?? 0)
		for (const list of children.values()) list.sort(sortByTime)
		roots.sort(sortByTime)

		const out: Array<{ row: any; depth: number }> = []
		const seen = new Set<string>()
		const walk = (r: any, depth: number) => {
			const sid = String(r?.span_id ?? '').trim()
			if (!sid || seen.has(sid)) return
			seen.add(sid)
			out.push({ row: r, depth })
			const kids = children.get(sid) ?? []
			for (const k of kids) walk(k, depth + 1)
		}
		for (const r of roots) walk(r, 0)
		return out
	}, [traceDetail])

	const facetKeysFiltered = useMemo(() => {
		const q2 = String(facetKeyQDebounced ?? '').trim().toLowerCase()
		const list = Array.isArray(facetKeys) ? facetKeys : []
		if (!q2) return list.slice(0, 300)
		return list.filter((r) => String(r.key ?? '').toLowerCase().includes(q2)).slice(0, 300)
	}, [facetKeys, facetKeyQDebounced])

	return (
		<Box p="xs" style={{ height: '100vh', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}>
			{header}
			<Box style={{ flex: 1, minHeight: 0 }}>
			{signal === 'sql' ? (
				<Paper withBorder p="xs" radius="md" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
					<Group justify="space-between" mb="xs" wrap="wrap">
						<Group gap="xs">
							<Title order={4}>DuckDB SQL</Title>
							<Badge variant="light" color="gray" leftSection={<IconTerminal2 size={14} />}>
								local
							</Badge>
						</Group>
						<Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={runSql} loading={sqlLoading}>
							运行
						</Button>
					</Group>

					<Textarea
						ref={(el) => {
							sqlRef.current = el
						}}
						value={sql}
						onChange={(e) => setSql(e.currentTarget.value)}
						placeholder="SQL..."
						minRows={2}
						maxRows={8}
					/>

					{sqlError ? (
						<Text size="xs" c="red" mt="xs">
							{sqlError}
						</Text>
					) : null}

					<Paper withBorder p="xs" radius="md" mt="xs" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
						{sqlLoading && !sqlResult ? (
							<Group justify="center" py="md">
								<Loader size="sm" />
							</Group>
						) : sqlResult ? (
							<ScrollArea h="100%">
								<Table withTableBorder>
									<Table.Thead>
										<Table.Tr>
											{sqlResult.columns.map((c) => (
												<Table.Th key={c}>{c}</Table.Th>
											))}
										</Table.Tr>
									</Table.Thead>
									<Table.Tbody>
										{sqlResult.rows.map((r, i) => (
											<Table.Tr key={i}>
												{sqlResult.columns.map((c) => (
													<Table.Td key={c}>{String((r as any)[c] ?? '')}</Table.Td>
												))}
											</Table.Tr>
										))}
									</Table.Tbody>
								</Table>
							</ScrollArea>
						) : (
							<Text size="sm" c="dimmed">
								运行一个查询以查看结果
							</Text>
						)}
					</Paper>

					<Text size="xs" c="dimmed" mt="xs">
						表：<Code>otlp_logs</Code> / <Code>otlp_spans</Code> / <Code>otlp_metrics</Code>
					</Text>
				</Paper>
			) : signal === 'traces' && selectedTraceId ? (
				<Paper
					withBorder
					radius="md"
					p="xs"
					style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
				>
					<Group justify="space-between" wrap="wrap">
						<Group gap="xs" wrap="wrap">
							<Button
								size="xs"
								variant="subtle"
								leftSection={<IconArrowLeft size={14} />}
								onClick={() => {
									closeTrace()
									void refreshList()
								}}
							>
								Back
							</Button>
							<Title order={4}>Trace</Title>
							<Code>{shortId(selectedTraceId, 14, 10)}</Code>
							<ActionIcon variant="light" aria-label="copy trace id" onClick={() => onCopy(selectedTraceId, 'traceId')}>
								<IconCopy size={16} />
							</ActionIcon>
							<Button
								size="xs"
								variant="light"
								leftSection={<IconTerminal2 size={14} />}
								onClick={() => {
									setSignal('sql')
									setSql(`select * from otlp_spans where trace_id = '${selectedTraceId.replaceAll("'", "''")}' order by start_ts_ms asc, seq asc;`)
								}}
							>
								SQL
							</Button>
							<Button
								size="xs"
								variant="light"
								leftSection={<IconExternalLink size={14} />}
								onClick={() => {
									try {
										window.open(window.location.href, '_blank', 'noopener,noreferrer')
									} catch {
										// ignore
									}
								}}
							>
								New tab
							</Button>
						</Group>

						<Group gap="xs" wrap="wrap">
							<Badge variant="light" color="gray">
								spans {(traceDetail as any)?.spans ?? 0}
							</Badge>
							<Badge variant="light" color={(Number((traceDetail as any)?.errors ?? 0) || 0) > 0 ? 'red' : 'gray'}>
								errors {(traceDetail as any)?.errors ?? 0}
							</Badge>
							<Badge variant="light" color="gray">
								dur {Math.round(Number((traceDetail as any)?.durationMs ?? 0) || 0)}ms
							</Badge>
							<ActionIcon
								variant="light"
								onClick={() => void refreshTraceDetail()}
								loading={traceLoading}
								aria-label="refresh trace"
							>
								<IconRefresh size={16} />
							</ActionIcon>
						</Group>
					</Group>

					{traceError ? (
						<Text size="xs" c="red" mt="xs">
							{traceError}
						</Text>
					) : null}

					<Divider my="xs" />

					<ScrollArea style={{ flex: 1 }}>
						<Table striped highlightOnHover withTableBorder verticalSpacing="xs" horizontalSpacing="xs">
							<Table.Thead>
								<Table.Tr>
									<Table.Th>span</Table.Th>
									<Table.Th>dur</Table.Th>
									<Table.Th>status</Table.Th>
									<Table.Th>kind</Table.Th>
									<Table.Th>timeline</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{traceLoading && !traceSpans.length ? (
									<Table.Tr>
										<Table.Td colSpan={5}>
											<Group justify="center" py="md">
												<Loader size="sm" />
											</Group>
										</Table.Td>
									</Table.Tr>
								) : traceSpans.length ? (
									traceSpans.map(({ row, depth }, i) => {
										const start = Number((row as any).start_ts_ms ?? 0)
										const end = Number((row as any).end_ts_ms ?? start)
										const t0 = Number((traceDetail as any)?.startTsMs ?? start)
										const dur = Math.max(1, Number((traceDetail as any)?.durationMs ?? Math.max(1, end - start)) || 1)
										const leftPct = Math.max(0, Math.min(100, ((start - t0) / dur) * 100))
										const widthPct = Math.max(0.5, Math.min(100 - leftPct, ((Math.max(0, end - start) || 1) / dur) * 100))
										const status = String((row as any).status ?? '')
										const barColor = status === 'error' ? 'var(--mantine-color-red-filled)' : 'var(--mantine-color-teal-filled)'
										return (
											<Table.Tr
												key={String((row as any).span_id ?? i)}
												onClick={() => {
													setSelected(row)
													setDrawerOpen(true)
												}}
												style={{ cursor: 'pointer' }}
											>
												<Table.Td>
													<Group gap={6} wrap="nowrap">
														<Box style={{ width: Math.min(240, depth * 12) }} />
														<Text size="xs">{shortText((row as any).name ?? '', 140)}</Text>
													</Group>
													<Text size="xs" c="dimmed">
														{shortId((row as any).span_id, 10, 6)}
													</Text>
												</Table.Td>
												<Table.Td>{Math.round(Number((row as any).duration_ms ?? 0) || 0)}ms</Table.Td>
												<Table.Td>
													{status === 'error' ? (
														<Badge variant="light" color="red">
															error
														</Badge>
													) : (
														<Badge variant="light" color="gray">
															{status || 'unset'}
														</Badge>
													)}
												</Table.Td>
												<Table.Td>
													<Badge variant="light" color="gray">
														{String((row as any).kind ?? '')}
													</Badge>
												</Table.Td>
												<Table.Td>
													<Box
														style={{
															position: 'relative',
															height: 14,
															borderRadius: 6,
															background: 'var(--mantine-color-gray-1)',
															overflow: 'hidden',
														}}
													>
														<Box
															style={{
																position: 'absolute',
																left: `${leftPct}%`,
																width: `${widthPct}%`,
																top: 2,
																height: 10,
																borderRadius: 6,
																background: barColor,
															}}
														/>
													</Box>
												</Table.Td>
											</Table.Tr>
										)
									})
								) : (
									<Table.Tr>
										<Table.Td colSpan={5}>
											<Group justify="center" py="md">
												<Text size="sm" c="dimmed">
													暂无数据
												</Text>
											</Group>
										</Table.Td>
									</Table.Tr>
								)}
							</Table.Tbody>
						</Table>
					</ScrollArea>
				</Paper>
			) : (
				<Paper withBorder radius="md" p="xs" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
					<Group justify="space-between" wrap="wrap">
						<Group gap="xs">
							<Title order={4}>{signal}</Title>
							<Badge variant="light" color="gray">
								{total}
							</Badge>
							{error ? (
								<Text size="sm" c="red">
									{error}
								</Text>
							) : null}
						</Group>
						<Group gap="xs">
							<Text size="sm" c="dimmed">
								page {page}/{totalPages}
							</Text>
							<ActionIcon variant="light" onClick={() => void refreshList()} loading={loading} aria-label="refresh">
								<IconRefresh size={16} />
							</ActionIcon>
						</Group>
					</Group>

					<ScrollArea style={{ flex: 1 }}>
						<Table striped highlightOnHover withTableBorder verticalSpacing="xs" horizontalSpacing="xs">
							<Table.Thead>
								<Table.Tr>
									{listColumns.map((c) => (
										<Table.Th key={c.key}>{c.label}</Table.Th>
									))}
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{loading && !rows.length ? (
									<Table.Tr>
										<Table.Td colSpan={Math.max(1, listColumns.length)}>
											<Group justify="center" py="md">
												<Loader size="sm" />
											</Group>
										</Table.Td>
									</Table.Tr>
								) : rows.length ? (
									rows.map((r, i) => (
										<Table.Tr key={String(r.seq ?? i)} onClick={() => openRow(r)} style={{ cursor: 'pointer' }}>
											{listColumns.map((c) => (
												<Table.Td key={c.key}>{(c as any).render(r)}</Table.Td>
											))}
										</Table.Tr>
									))
								) : (
									<Table.Tr>
										<Table.Td colSpan={Math.max(1, listColumns.length)}>
											<Group justify="center" py="md">
												<Text size="sm" c="dimmed">
													暂无数据
												</Text>
											</Group>
										</Table.Td>
									</Table.Tr>
								)}
							</Table.Tbody>
						</Table>
					</ScrollArea>

					<Group justify="space-between" mt="xs" wrap="wrap">
						<Pagination value={page} onChange={setPage} total={totalPages} size="xs" />
						<Text size="xs" c="dimmed">
							点击行打开详情 · Ctrl/Cmd+K 清空筛选
						</Text>
					</Group>
				</Paper>
			)}
			</Box>

			<Drawer opened={filtersOpen} onClose={() => setFiltersOpen(false)} position="left" size="lg" title="Filters & Explorer">
				<ScrollArea h="calc(100vh - 90px)">
					<Stack gap="sm">
						<Group gap="xs" wrap="wrap" align="flex-end">
							<TextInput
								size="xs"
								type="number"
								w={110}
								value={String(seedCount)}
								onChange={(e) => setSeedCount(Math.max(1, Math.min(5000, Math.floor(Number(e.currentTarget.value) || 50))))}
								placeholder="seed n"
							/>
							<Button
								size="xs"
								variant="light"
								onClick={() => {
									void rpc.seed('logs', seedCount).then(
										(out) => {
											flash(`Seeded logs: ${out.inserted}`)
											void refreshStats()
											void refreshList()
										},
										(err) => flash(rpcErrorMessage(err, 'Seed logs failed')),
									)
								}}
								disabled={!stats?.enabled}
							>
								Seed Logs
							</Button>
							<Button
								size="xs"
								variant="light"
								onClick={() => {
									void rpc.seed('traces', seedCount).then(
										(out) => {
											flash(`Seeded traces: ${out.inserted}`)
											void refreshStats()
											void refreshList()
										},
										(err) => flash(rpcErrorMessage(err, 'Seed traces failed')),
									)
								}}
								disabled={!stats?.enabled}
							>
								Seed Traces
							</Button>
							<Button
								size="xs"
								variant="light"
								onClick={() => {
									void rpc.seed('metrics', seedCount).then(
										(out) => {
											flash(`Seeded metrics: ${out.inserted}`)
											void refreshStats()
											void refreshList()
										},
										(err) => flash(rpcErrorMessage(err, 'Seed metrics failed')),
									)
								}}
								disabled={!stats?.enabled}
							>
								Seed Metrics
							</Button>
							<Button
								size="xs"
								variant="light"
								onClick={() => {
									void rpc.seed('mixed', seedCount).then(
										(out) => {
											flash(`Seeded mixed: ${out.inserted}`)
											void refreshStats()
											void refreshList()
										},
										(err) => flash(rpcErrorMessage(err, 'Seed mixed failed')),
									)
								}}
								disabled={!stats?.enabled}
							>
								Seed Mixed
							</Button>
							<Button
								size="xs"
								variant="light"
								color="red"
								onClick={() => {
									void rpc.clearAll().then(
										() => {
											setSelected(null)
											setDrawerOpen(false)
											flash('Cleared')
											void refreshStats()
											void refreshList()
										},
										(err) => flash(rpcErrorMessage(err, 'Clear failed')),
									)
								}}
								disabled={!stats?.enabled}
							>
								Clear store
							</Button>
							</Group>

							<Divider />

							<Group gap="xs" wrap="wrap">
								<Button
									size="xs"
									variant="light"
									onClick={() => {
										setSignal('traces')
										addFilter({ field: 'attr.ax.flow', op: 'eq', value: 'univer.loopback' })
									}}
								>
									Univer AxFlow
								</Button>
								<Button
									size="xs"
									variant="light"
									onClick={() => {
										setSignal('traces')
										addFilter({ field: 'name', op: 'contains', value: 'univer.ax.fetch' })
									}}
								>
									Ax fetch spans
								</Button>
								<Button
									size="xs"
									variant="light"
									onClick={() => {
										if (signal === 'logs') setLevel('error')
										else if (signal === 'traces') setStatus('error')
										else if (signal === 'metrics') addFilter({ field: 'name', op: 'contains', value: 'error' })
									}}
								>
									Errors
								</Button>
							</Group>

							<Divider />

							<Group gap="xs" wrap="wrap" align="flex-end">
								<TextInput
									size="xs"
									w={260}
									list="otlp-field-suggestions"
									placeholder="field (traceId, status, attr.http.request.method...)"
									value={filterField}
									onChange={(e) => setFilterField(e.currentTarget.value)}
								/>
							<datalist id="otlp-field-suggestions">
								{filterFieldSuggestions.map((f) => (
									<option key={f} value={f} />
								))}
							</datalist>
							<SegmentedControl
								size="xs"
								value={filterOp}
								onChange={(v) => setFilterOp(v as any)}
								data={[
									{ value: 'eq', label: '=' },
									{ value: 'neq', label: '!=' },
									{ value: 'contains', label: 'contains' },
									{ value: 'like', label: 'like' },
									{ value: 'exists', label: 'exists' },
									{ value: 'gt', label: '>' },
									{ value: 'gte', label: '>=' },
									{ value: 'lt', label: '<' },
									{ value: 'lte', label: '<=' },
								]}
							/>
							<TextInput
								size="xs"
								w={220}
								placeholder={filterOp === 'exists' ? '(unused)' : 'value'}
								disabled={filterOp === 'exists'}
								value={filterValue}
								onChange={(e) => setFilterValue(e.currentTarget.value)}
								onKeyDown={(e) => {
									if (e.key !== 'Enter') return
									const f = { field: filterField, op: filterOp, ...(filterOp === 'exists' ? {} : { value: filterValue }) }
									addFilter(f)
								}}
							/>
							<Button
								size="xs"
								variant="light"
								onClick={() => {
									const f = { field: filterField, op: filterOp, ...(filterOp === 'exists' ? {} : { value: filterValue }) }
									addFilter(f)
								}}
							>
								Add
							</Button>
							<Button
								size="xs"
								variant="subtle"
								onClick={() => {
									setFilters([])
									flash('Filters cleared')
								}}
							>
								Clear filters
							</Button>
						</Group>

						{filters.length ? (
							<Group gap="xs" wrap="wrap">
								{filters.map((f, i) => (
									<Badge
										key={`${f.field}:${f.op}:${String(f.value ?? '')}:${i}`}
										variant="light"
										color="blue"
										rightSection={
											<ActionIcon
												size="xs"
												variant="subtle"
												aria-label="remove filter"
												onClick={() => {
													setFilters((prev) => prev.filter((_, idx) => idx !== i))
												}}
											>
												<IconX size={12} />
											</ActionIcon>
										}
									>
										{f.field} {f.op}
										{f.op === 'exists' ? '' : ` ${String(f.value ?? '')}`}
									</Badge>
								))}
							</Group>
						) : (
							<Text size="xs" c="dimmed">
								字段：列名或 <Code>attr.&lt;key&gt;</Code>
							</Text>
						)}

						<Divider />

						<Group justify="space-between" wrap="wrap" gap="xs" align="center">
							<Group gap="xs" wrap="wrap">
								<Title order={5}>Attribute Explorer</Title>
								<Badge variant="light" color="gray">
									sampled {facetScanRows.toLocaleString()}
								</Badge>
								{facetKeysLoading ? <Loader size="xs" /> : null}
								{facetKeysError ? (
									<Text size="xs" c="red">
										{facetKeysError}
									</Text>
								) : null}
							</Group>
							<Group gap="xs" wrap="wrap" align="center">
								<SegmentedControl
									size="xs"
									value={String(facetScanRows)}
									onChange={(v) => setFacetScanRows(Number(v) || 20_000)}
									data={[
										{ value: '5000', label: '5k' },
										{ value: '20000', label: '20k' },
										{ value: '100000', label: '100k' },
									]}
								/>
								<ActionIcon size="sm" variant="light" aria-label="refresh keys" onClick={() => void refreshFacetKeys()}>
									<IconRefresh size={16} />
								</ActionIcon>
								<TextInput
									size="xs"
									w={220}
									placeholder="search keys..."
									value={facetKeyQ}
									onChange={(e) => setFacetKeyQ(e.currentTarget.value)}
								/>
							</Group>
						</Group>

						<SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
							<Paper withBorder p="xs" radius="md">
								<Group justify="space-between" mb="xs" wrap="nowrap">
									<Text size="xs" c="dimmed">
										Keys
									</Text>
									<Badge variant="light" color="gray">
										{facetKeysFiltered.length}/{facetKeys.length}
									</Badge>
								</Group>
								<ScrollArea h={320}>
									<Table withTableBorder striped highlightOnHover>
										<Table.Tbody>
											{facetKeysFiltered.map((r) => (
												<Table.Tr
													key={r.key}
													onClick={() => {
														setFacetSelectedKey(r.key)
														void refreshFacetValues(r.key)
													}}
													style={{ cursor: 'pointer' }}
												>
													<Table.Td>
														<Text size="xs" fw={facetSelectedKey === r.key ? 700 : 400}>
															{r.key}
														</Text>
													</Table.Td>
													<Table.Td w={54}>
														<Text size="xs" c="dimmed">
															{r.n}
														</Text>
													</Table.Td>
													<Table.Td w={74}>
														<Button
															size="xs"
															variant="subtle"
															onClick={(e) => {
																e.stopPropagation()
																addFilter({ field: `attr.${r.key}`, op: 'exists' })
															}}
														>
															exists
														</Button>
													</Table.Td>
												</Table.Tr>
											))}
										</Table.Tbody>
									</Table>
								</ScrollArea>
							</Paper>

							<Paper withBorder p="xs" radius="md">
								<Group justify="space-between" mb="xs" wrap="nowrap">
									<Text size="xs" c="dimmed">
										Values {facetSelectedKey ? <Code>{facetSelectedKey}</Code> : null}
									</Text>
									<Group gap="xs" wrap="nowrap">
										{facetValuesLoading ? <Loader size="xs" /> : null}
										{facetValuesError ? (
											<Text size="xs" c="red">
												{facetValuesError}
											</Text>
										) : null}
									</Group>
								</Group>
								<ScrollArea h={320}>
									{facetSelectedKey ? (
										<Table withTableBorder striped highlightOnHover>
											<Table.Tbody>
												{facetValues.slice(0, 300).map((r, i) => (
													<Table.Tr key={`${r.value}:${r.type}:${i}`}>
														<Table.Td>
															<Text size="xs" style={{ wordBreak: 'break-word' }}>
																{shortText(r.value, 120)}
															</Text>
														</Table.Td>
														<Table.Td w={88}>
															<Text size="xs" c="dimmed">
																{r.type}
															</Text>
														</Table.Td>
														<Table.Td w={54}>
															<Text size="xs" c="dimmed">
																{r.n}
															</Text>
														</Table.Td>
														<Table.Td w={46}>
															<Button
																size="xs"
																variant="subtle"
																onClick={() => addFilter({ field: `attr.${facetSelectedKey}`, op: 'eq', value: r.value })}
															>
																=
															</Button>
														</Table.Td>
													</Table.Tr>
												))}
											</Table.Tbody>
										</Table>
									) : (
										<Text size="xs" c="dimmed">
											选择一个 key 查看 values
										</Text>
									)}
								</ScrollArea>
							</Paper>
						</SimpleGrid>
					</Stack>
				</ScrollArea>
			</Drawer>

			<RowDrawer
				open={drawerOpen}
				onClose={() => setDrawerOpen(false)}
				title={`${signal} detail`}
				row={selected}
				onCopy={onCopy}
				onFilterCallerId={(id) => setCallerId(id)}
				onFilterQ={(qq) => setQ(qq)}
				onFilterName={(nn) => setName(nn)}
				onOpenTrace={openTrace}
				onAddFilter={addFilter}
			/>
		</Box>
	)
}

export default definePluginUIModule({
	routes: [
		{
			definition: {
				path: '/otlp',
				title: 'OTLP',
				addToNav: true,
				navPriority: 30,
				frame: 'standalone',
			},
			render: () => <OtlpViewerPage />,
		},
	],
})
