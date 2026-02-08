import { Divider, SideSheet, Space, Table, Tag, Typography } from '@douyinfe/semi-ui-19'
import type { UniverPluginSpec } from '@pluxel/univer-protocol'
import { useMemo } from 'react'

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

export function DebugDrawer(props: {
	opened: boolean
	onClose(): void
	ready: boolean
	workbookId: string
	getRuntime(): UniverRuntime | null
	rawPlugins(): UniverPluginSpec[]
	effectivePlugins(): UniverPluginSpec[]
	services: { workbooks: boolean; ai: boolean }
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
			</Space>
		</SideSheet>
	)
}
