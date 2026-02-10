import { Divider, SideSheet, Space, Table, Tag, Typography } from '@douyinfe/semi-ui-19'
import type { HmrWebClient } from '@pluxel/hmr/web'
import {
	UNIVER_AI_SSE_NS,
	type UniverAiThreadEventEnvelope,
	type UniverAiThreadSnapshot,
	type UniverCapabilitiesSnapshot,
	type UniverPluginSpec,
} from '@pluxel/univer-protocol'
import { useEffect, useMemo, useRef, useState } from 'react'

import { CodeInline, Muted, SectionTitle } from '../kit'
import type { UniverRuntime } from '../univer/runtime'
import { isSupportedUniverPluginKey } from '../univer/catalog'

function stableJson(value: unknown): string {
	try {
		return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2)
	} catch {
		return String(value)
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseAiSnapshot(payload: unknown): UniverAiThreadSnapshot | null {
	if (!isRecord(payload)) return null
	if (payload.schema !== 1) return null
	if (typeof payload.threadId !== 'string' || !payload.threadId) return null
	if (typeof payload.baseOffset !== 'number' || typeof payload.nextOffset !== 'number') return null
	if (!Array.isArray(payload.events)) return null
	return payload as any
}

function parseAiEnvelope(payload: unknown): UniverAiThreadEventEnvelope | null {
	if (!isRecord(payload)) return null
	if (payload.schema !== 1) return null
	if (typeof payload.threadId !== 'string' || !payload.threadId) return null
	if (typeof payload.offset !== 'number' || !Number.isFinite(payload.offset)) return null
	if (!isRecord(payload.event)) return null
	const type = (payload.event as any).type
	if (typeof type !== 'string' || !type) return null
	return payload as any
}

function formatAiEvent(env: UniverAiThreadEventEnvelope) {
	const e = env.event as any
	const at = typeof e.at === 'number' ? e.at : 0
	const time = at ? new Date(at).toLocaleTimeString() : ''
	const type = String(e.type ?? '')
	const req = typeof e.requestId === 'string' ? e.requestId : ''

	let detail = ''
	if (type === 'request') {
		const hint = e.contextHint?.a1 ? ` · ${String(e.contextHint.a1)}` : ''
		const text = typeof e.instruction === 'string' ? e.instruction : ''
		detail = `${text.slice(0, 180)}${text.length > 180 ? '…' : ''}${hint}`
	} else if (type === 'status') {
		const stage = typeof e.stage === 'string' ? e.stage : ''
		const msg = typeof e.message === 'string' && e.message ? ` · ${e.message}` : ''
		detail = `${stage}${msg}`
	} else if (type === 'result') {
		const changes = typeof e.changes === 'number' ? e.changes : 0
		const ops = typeof e.ops === 'number' ? e.ops : 0
		const summary = typeof e.summary === 'string' && e.summary ? ` · ${e.summary}` : ''
		detail = `changes=${changes} · ops=${ops}${summary}`
	} else if (type === 'error') {
		detail = typeof e.error === 'string' ? e.error : ''
	}

	return { time, type, req, detail }
}

export function DebugDrawer(props: {
	opened: boolean
	onClose(): void
	ready: boolean
	workbookId: string
	aiThreadId?: string
	createSse?: HmrWebClient['createSse']
	getRuntime(): UniverRuntime | null
	rawPlugins(): UniverPluginSpec[]
	effectivePlugins(): UniverPluginSpec[]
	services: { workbooks: boolean; ai: boolean }
	capabilities?: UniverCapabilitiesSnapshot | null
}) {
	const rt = props.getRuntime()
	const installed = useMemo(
		() => [...(rt?.installedPlugins ?? new Set())].sort((a, b) => a.localeCompare(b)),
		[rt],
	)

	const raw = useMemo(() => {
		const list = props.rawPlugins().slice()
		list.sort((a, b) => a.plugin.localeCompare(b.plugin) || a.id.localeCompare(b.id))
		return list
	}, [props])

	const effective = useMemo(() => {
		const list = props.effectivePlugins().slice()
		list.sort((a, b) => a.plugin.localeCompare(b.plugin) || a.id.localeCompare(b.id))
		return list
	}, [props])

	const unsupported = useMemo(() => raw.filter((p) => !isSupportedUniverPluginKey(p.plugin)), [raw])
	const caps = props.capabilities ?? null

	const [aiSnap, setAiSnap] = useState<UniverAiThreadSnapshot | null>(null)
	const [aiEvents, setAiEvents] = useState<UniverAiThreadEventEnvelope[]>([])
	const [aiError, setAiError] = useState<string | null>(null)
	const lastAiOffsetRef = useRef<number>(-1)

	useEffect(() => {
		if (!props.opened) return
		if (!props.services.ai) return
		if (!props.createSse) return
		if (!props.aiThreadId) return

		setAiSnap(null)
		setAiEvents([])
		setAiError(null)
		lastAiOffsetRef.current = -1

		const sse = props.createSse({
			namespaces: [UNIVER_AI_SSE_NS],
			params: { threadId: props.aiThreadId, after: -1, limit: 200 },
		})

		const off = sse.ns(UNIVER_AI_SSE_NS).on(
			(msg) => {
				if (msg.event === 'snapshot') {
					const snap = parseAiSnapshot(msg.payload)
					if (!snap) return
					setAiSnap(snap)
					setAiEvents(snap.events)
					const last = snap.events.at(-1)
					lastAiOffsetRef.current = last ? last.offset : -1
					return
				}
				if (msg.event === 'append') {
					const env = parseAiEnvelope(msg.payload)
					if (!env) return
					setAiEvents((prev) => {
						if (prev.length && prev[prev.length - 1]!.offset >= env.offset) {
							// Best-effort de-dupe when reconnect happens.
							if (prev.some((e) => e.offset === env.offset)) return prev
						}
						return [...prev, env]
					})
					lastAiOffsetRef.current = env.offset
					return
				}
				if (msg.event === 'error') {
					const p = msg.payload as any
					const message = typeof p?.message === 'string' ? p.message : 'AI SSE error'
					setAiError(message)
				}
			},
			['snapshot', 'append', 'error'],
		)

		return () => {
			off()
			sse.close()
		}
	}, [props.aiThreadId, props.createSse, props.opened, props.services.ai])

	const aiRows = useMemo(() => {
		return aiEvents
			.slice()
			.sort((a, b) => a.offset - b.offset)
			.map((env) => ({ key: String(env.offset), offset: env.offset, ...formatAiEvent(env) }))
	}, [aiEvents])

	return (
		<SideSheet
			visible={props.opened}
			onCancel={props.onClose}
			title="Debug"
			placement="right"
			width={720}
		>
			<Space vertical align="start" spacing="loose" style={{ width: '100%' }}>
				<Space align="start" spacing="loose" style={{ width: '100%', justifyContent: 'space-between' }}>
					<div>
						<SectionTitle>Runtime</SectionTitle>
						<Muted>
							ready: <CodeInline>{String(props.ready)}</CodeInline> · workbook:{' '}
							<CodeInline>{props.workbookId || '(none)'}</CodeInline>
						</Muted>
					</div>
					<Space>
						<Tag color={props.services.workbooks ? 'green' : 'grey'}>workbooks</Tag>
						<Tag color={props.services.ai ? 'green' : 'grey'}>ai</Tag>
					</Space>
				</Space>

				<Divider />

				<div style={{ width: '100%' }}>
					<SectionTitle>Installed (runtime)</SectionTitle>
					<Space wrap style={{ marginTop: 8 }}>
						{installed.length ? (
							installed.map((k) => (
								<Tag key={k} color="blue">
									{k}
								</Tag>
							))
						) : (
							<Muted>(no installed plugins)</Muted>
						)}
					</Space>
				</div>

				<Divider />

				<div style={{ width: '100%' }}>
					<SectionTitle>Effective (SSE)</SectionTitle>
					<Table
						dataSource={effective}
						rowKey="id"
						pagination={false}
						columns={[
							{
								title: 'plugin',
								dataIndex: 'plugin',
								render: (value: string) => <CodeInline>{value}</CodeInline>,
							},
							{
								title: 'id',
								dataIndex: 'id',
								render: (value: string) => <CodeInline>{value}</CodeInline>,
							},
							{
								title: 'supported',
								dataIndex: 'plugin',
								render: (value: string) => (isSupportedUniverPluginKey(value) ? 'yes' : 'no'),
							},
						]}
					/>
				</div>

				<div style={{ width: '100%' }}>
					<SectionTitle>Raw (SSE)</SectionTitle>
					<Table
						dataSource={raw}
						rowKey="id"
						pagination={false}
						columns={[
							{
								title: 'plugin',
								dataIndex: 'plugin',
								render: (value: string) => <CodeInline>{value}</CodeInline>,
							},
							{
								title: 'id',
								dataIndex: 'id',
								render: (value: string) => <CodeInline>{value}</CodeInline>,
							},
						]}
					/>
				</div>

				{unsupported.length ? (
					<>
						<Divider />
						<div style={{ width: '100%' }}>
							<SectionTitle>Unsupported plugins</SectionTitle>
							<Typography.Text type="tertiary">
								{unsupported.length} plugin(s) not supported by Univer frontend.
							</Typography.Text>
							<pre className="univer-codeblock" style={{ marginTop: 8 }}>
								{stableJson(unsupported)}
							</pre>
						</div>
					</>
				) : null}

				{caps ? (
					<>
						<Divider />
						<div style={{ width: '100%' }}>
							<SectionTitle>Capabilities</SectionTitle>
							<Typography.Text type="tertiary">
								updatedAt: <CodeInline>{String(caps.updatedAt)}</CodeInline>
							</Typography.Text>
							<pre className="univer-codeblock" style={{ marginTop: 8 }}>
								{stableJson(caps.items)}
							</pre>
						</div>
					</>
				) : null}

				{props.services.ai && props.aiThreadId && props.createSse ? (
					<>
						<Divider />
						<div style={{ width: '100%' }}>
							<SectionTitle>AI Thread</SectionTitle>
							<Typography.Text type="tertiary">
								threadId: <CodeInline>{props.aiThreadId}</CodeInline>
								{aiSnap ? (
									<>
										{' '}
										· base: <CodeInline>{String(aiSnap.baseOffset)}</CodeInline> · next:{' '}
										<CodeInline>{String(aiSnap.nextOffset)}</CodeInline>
									</>
								) : null}
								{aiError ? (
									<>
										{' '}
										· <Typography.Text type="danger">{aiError}</Typography.Text>
									</>
								) : null}
							</Typography.Text>
							<Table
								dataSource={aiRows}
								rowKey="key"
								pagination={false}
								size="small"
								style={{ marginTop: 8 }}
								columns={[
									{
										title: 'offset',
										dataIndex: 'offset',
										width: 90,
										render: (v: number) => <CodeInline>{String(v)}</CodeInline>,
									},
									{
										title: 'time',
										dataIndex: 'time',
										width: 110,
									},
									{
										title: 'type',
										dataIndex: 'type',
										width: 110,
										render: (v: string) => <Tag size="small">{v}</Tag>,
									},
									{
										title: 'requestId',
										dataIndex: 'req',
										width: 210,
										render: (v: string) => (v ? <CodeInline>{v}</CodeInline> : <Muted>(none)</Muted>),
									},
									{
										title: 'detail',
										dataIndex: 'detail',
										render: (v: string) => <Typography.Text>{v || '(empty)'}</Typography.Text>,
									},
								]}
							/>
						</div>
					</>
				) : null}
			</Space>
		</SideSheet>
	)
}
