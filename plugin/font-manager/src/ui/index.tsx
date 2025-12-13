import {
	Alert,
	Badge,
	Button,
	Code,
	Group,
	Loader,
	MultiSelect,
	Paper,
	ScrollArea,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { IconAlertCircle, IconFolder, IconReload, IconSearch, IconTypography } from '@tabler/icons-react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
	definePluginUIModule,
	type PluginExtensionContext,
	hmrWebClient,
	rpcErrorMessage,
} from '@pluxel/hmr/web'
import type { FontSnapshot } from '../font-manager'

type Snapshot = FontSnapshot
type Source = Snapshot['sources'][number]
type ResolvedMap = Snapshot['resolved']
type FontFamilyInfo = Snapshot['families'][number]
const DEFAULT_GROUP_KEYS = ['sans', 'serif', 'mono', 'fallback'] as const

type RpcClient = {
	snapshot: () => Promise<Snapshot>
	reload: (reason?: string) => Promise<Snapshot>
	setPreferred: (key: string, families: string[]) => Promise<void>
}

const rpc = (): RpcClient => (hmrWebClient.rpc as any).FontManager as RpcClient

function useFontManagerData() {
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const fetchSnapshot = useCallback(async () => {
		setLoading(true)
		try {
			const snap = await rpc().snapshot()
			setSnapshot(snap)
			setError(null)
		} catch (err) {
			setError(rpcErrorMessage(err, '无法加载字体状态'))
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		void fetchSnapshot()
	}, [fetchSnapshot])

	useEffect(() => {
		const sse = hmrWebClient.createSse({ namespaces: ['FontManager'] })
		const off = sse.ns('FontManager').on((msg) => {
			const payload = msg.payload as { type?: string; snapshot?: Snapshot } | undefined
			if (payload?.type === 'sync' && payload.snapshot) {
				setSnapshot(payload.snapshot)
			}
		}, ['sync'])
		return () => {
			off()
			sse.close()
		}
	}, [])

	return { snapshot, loading, error, fetchSnapshot }
}

function Overview({ snapshot, onReload, reloading }: { snapshot: Snapshot | null; onReload: () => void; reloading: boolean }) {
	const primary = snapshot?.primary ?? 'sans-serif'
	const stack = snapshot?.stack ?? []
	const lastLoaded = snapshot?.lastLoadedAt ? new Date(snapshot.lastLoadedAt).toLocaleString() : '未加载'

	return (
		<Paper withBorder p="md" radius="md">
			<Group justify="space-between" align="flex-start">
				<Stack gap={6}>
				<Group gap="xs">
					<Title order={4}>字体管理</Title>
					<Badge color="teal" variant="light" leftSection={<IconTypography size={14} />}>
						{primary}
					</Badge>
				</Group>
				<Text size="sm" c="dimmed">
					当前字体栈
				</Text>
				<Code>{stack.length ? stack.join(', ') : '空'}</Code>
				<Text size="xs" c="dimmed">
						上次加载：{lastLoaded}
					</Text>
				</Stack>
				<Button size="sm" variant="light" loading={reloading} leftSection={<IconReload size={14} />} onClick={onReload}>
					重新加载
				</Button>
			</Group>
		</Paper>
	)
}

function PreferredEditor({
	resolved,
	onSave,
	aliases,
	families,
	saving,
}: {
	resolved: ResolvedMap
	aliases: Snapshot['aliases']
	families: Snapshot['families']
	onSave: (key: string, families: string[]) => Promise<void>
	saving: string | null
}) {
	const [values, setValues] = useState<Record<string, string[]>>({})
	const [newKey, setNewKey] = useState('')
	const [groupFilter, setGroupFilter] = useState('')
	const familyOptions = useMemo(() => {
		const seen = new Set<string>()
		return (families ?? []).reduce<{ value: string; label: string }[]>((acc, item) => {
			if (!item?.family || seen.has(item.family)) {
				return acc
			}
			seen.add(item.family)
			const count = item.styles?.length ?? 0
			acc.push({
				value: item.family,
				label: count ? `${item.family} (${count})` : item.family,
			})
			return acc
		}, [])
	}, [families])

	useEffect(() => {
		setValues((prev) => {
			const next: Record<string, string[]> = { ...prev }
			const ensure = new Set([
				...DEFAULT_GROUP_KEYS,
				...Object.keys(aliases ?? {}),
				...Object.keys(resolved ?? {}),
			])
			for (const key of ensure) {
				const resolvedValue = resolved?.[key]
				next[key] = resolvedValue ? [...resolvedValue] : next[key] ?? []
			}
			return next
		})
	}, [resolved, aliases])

	const protectedKeys = useMemo(
		() => new Set([...DEFAULT_GROUP_KEYS, ...Object.keys(aliases ?? {})]),
		[aliases],
	)

	const keys = useMemo(() => {
		const seen = new Set<string>()
		const ordered: string[] = []
		const append = (key: string) => {
			if (!key || seen.has(key)) {
				return
			}
			seen.add(key)
			ordered.push(key)
		}

		DEFAULT_GROUP_KEYS.forEach(append)
		Object.keys(aliases ?? {}).forEach(append)

		const dynamicKeys = Array.from(new Set([...Object.keys(resolved ?? {}), ...Object.keys(values ?? {})])).sort(
			(a, b) => a.localeCompare(b),
		)
		dynamicKeys.forEach(append)
		return ordered
	}, [aliases, resolved, values])

	const filteredKeys = useMemo(() => {
		const q = groupFilter.trim().toLowerCase()
		if (!q) return keys
		return keys.filter((key) => key.toLowerCase().includes(q))
	}, [keys, groupFilter])

	const handleSave = async (key: string) => {
		const selected = values[key]?.filter(Boolean) ?? []
		await onSave(key, selected)
	}

	const handleAddKey = () => {
		const trimmed = newKey.trim()
		if (!trimmed || values[trimmed]) return
		setValues((prev) => ({ ...prev, [trimmed]: [] }))
		setNewKey('')
	}

	const handleRemoveKey = async (key: string) => {
		setValues((prev) => {
			const next = { ...prev }
			delete next[key]
			return next
		})
		await onSave(key, [])
	}

	return (
		<Paper withBorder p="md" radius="md">
			<Group gap="xs" mb="sm">
				<IconTypography size={16} />
				<Text fw={600}>默认字体栈</Text>
				<Text size="xs" c="dimmed">
					为不同组别选择可用字体，供 API 和其他插件引用
				</Text>
			</Group>
			<Text size="xs" c="dimmed" mb="xs">
				字体选项来自已加载字体，支持创建自定义组名（如 body、heading 等）
			</Text>
			<TextInput
				placeholder="筛选组名…"
				value={groupFilter}
				onChange={(e) => setGroupFilter(e.currentTarget.value)}
				size="xs"
				mb="sm"
			/>
			<Stack gap="sm">
				{filteredKeys.map((key) => (
						<Group key={key} align="flex-end" gap="sm">
							<MultiSelect
								style={{ flex: 1 }}
								label={`${key} ${aliases?.[key] ? `(→ ${aliases[key]})` : ''}`}
							description={
								aliases?.[key] ? `别名映射到 ${aliases[key]} 组` : '按顺序决定 fallback'
							}
								data={familyOptions}
								searchable
								comboboxProps={{ withinPortal: true }}
								nothingFoundMessage="暂无字体"
								placeholder={familyOptions.length ? '选择字体…' : '暂无字体可选'}
							value={values[key] ?? []}
							onChange={(val) => setValues((prev) => ({ ...prev, [key]: val }))}
							disabled={!familyOptions.length}
						/>
						<Stack gap={4}>
							<Button size="xs" loading={saving === key} onClick={() => void handleSave(key)}>
								保存
							</Button>
							{!protectedKeys.has(key) ? (
								<Button
									size="xs"
									variant="subtle"
									color="red"
									loading={saving === key}
									onClick={() => void handleRemoveKey(key)}
								>
									移除
								</Button>
							) : null}
						</Stack>
					</Group>
				))}
			</Stack>
			<Group align="flex-end" gap="sm" mt="md">
				<TextInput
					style={{ flex: 1 }}
					label="新增字体组"
					placeholder="例如 body、heading、display"
					value={newKey}
					onChange={(e) => setNewKey(e.currentTarget.value)}
				/>
				<Button size="xs" variant="light" onClick={handleAddKey} disabled={!newKey.trim()}>
					添加
				</Button>
			</Group>
			{aliases && Object.keys(aliases).length ? (
				<Text size="xs" c="dimmed" mt="sm">
					别名映射：{' '}
					{Object.entries(aliases)
						.map(([k, v]) => `${k}→${v}`)
						.join('，')}
				</Text>
			) : null}
		</Paper>
	)
}

function Sources({ sources }: { sources: Source[] }) {
	if (!sources.length) {
		return (
			<Alert color="gray" variant="light" icon={<IconAlertCircle size={16} />}>
				暂未加载字体来源
			</Alert>
		)
	}

	return (
		<ScrollArea h={260} type="auto">
			<Table verticalSpacing="xs" stickyHeader>
				<Table.Thead>
					<Table.Tr>
						<Table.Th>来源</Table.Th>
						<Table.Th>路径</Table.Th>
						<Table.Th>状态</Table.Th>
						<Table.Th>数量</Table.Th>
						<Table.Th>时间</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{sources.map((src) => (
						<Table.Tr key={`${src.type}:${src.path ?? src.id}`}>
							<Table.Td>
								<Group gap={6}>
									<Badge color="blue" variant="light">
										{src.type === 'system' ? '系统' : src.type === 'dir' ? '目录' : '文件'}
									</Badge>
									{src.alias ? <Badge variant="outline">{src.alias}</Badge> : null}
								</Group>
							</Table.Td>
							<Table.Td>
								<Text size="sm" lineClamp={1} title={src.path}>
									{src.path ?? '-'}
								</Text>
							</Table.Td>
							<Table.Td>
								<Group gap={6}>
									<Badge color={src.status === 'ok' ? 'teal' : src.status === 'skipped' ? 'gray' : 'red'} variant="light">
										{src.status}
									</Badge>
									{src.message ? (
										<Text size="xs" c="dimmed" lineClamp={1} title={src.message}>
											{src.message}
										</Text>
									) : null}
								</Group>
							</Table.Td>
							<Table.Td>{src.count ?? '-'}</Table.Td>
							<Table.Td>{src.loadedAt ? new Date(src.loadedAt).toLocaleTimeString() : '-'}</Table.Td>
						</Table.Tr>
					))}
				</Table.Tbody>
			</Table>
		</ScrollArea>
	)
}

function FontsLibrary({ families, loading }: { families: Snapshot['families']; loading: boolean }) {
	const [query, setQuery] = useState('')
	const normalized = query.trim().toLowerCase()
	const filtered = useMemo(() => {
		if (!families?.length) return []
		if (!normalized) return families
		return families.filter((family) => family.family?.toLowerCase().includes(normalized))
	}, [families, normalized])

	const stylesSummary = (styles: FontFamilyInfo['styles']) => {
		if (!styles?.length) return '无样式信息'
		const weights = Array.from(new Set(styles.map((s) => s.weight))).sort((a, b) => a - b)
		const italicCount = styles.filter((s) => s.style === 'italic').length
		const weightLabel =
			weights.length > 8
				? `${weights.slice(0, 8).join(', ')}…`
				: weights.join(', ')
		const italicLabel = italicCount ? `，含 ${italicCount} 款斜体` : ''
		return `权重 ${weightLabel}${italicLabel}`
	}

	const sampleText = 'The quick brown 狐狸 123'

	return (
		<Paper withBorder p="md" radius="md">
			<Group justify="space-between" mb="sm">
				<Group gap="xs">
					<IconTypography size={16} />
					<Text fw={600}>字体库</Text>
				</Group>
				<Text size="xs" c="dimmed">
					{filtered.length}/{families?.length ?? 0} 个字体
				</Text>
			</Group>
			<TextInput
				placeholder="搜索字体名称…"
				leftSection={<IconSearch size={16} />}
				value={query}
				onChange={(e) => setQuery(e.currentTarget.value)}
				mb="sm"
			/>
			<ScrollArea h={420} type="auto">
				{loading ? (
					<Group justify="center" py="md">
						<Loader size="sm" />
					</Group>
				) : filtered.length ? (
					<Table striped highlightOnHover withColumnBorders horizontalSpacing="md" verticalSpacing="xs">
						<Table.Thead>
							<Table.Tr>
								<Table.Th style={{ width: '26%' }}>字体</Table.Th>
								<Table.Th style={{ width: '20%' }}>样式</Table.Th>
								<Table.Th>预览</Table.Th>
								<Table.Th style={{ width: '12%' }}>样本数</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{filtered.map((family) => (
								<Table.Tr key={family.family}>
									<Table.Td>
										<Text fw={600}>{family.family}</Text>
									</Table.Td>
									<Table.Td>
										<Text size="sm" c="dimmed">
											{stylesSummary(family.styles)}
										</Text>
									</Table.Td>
									<Table.Td>
										<Text size="sm" style={{ fontFamily: `'${family.family}', sans-serif` }}>
											{sampleText}
										</Text>
									</Table.Td>
									<Table.Td>
										<Text size="sm">{family.styles?.length ?? 0}</Text>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				) : (
					<Text size="sm" c="dimmed" ta="center" py="md">
						未找到匹配字体
					</Text>
				)}
			</ScrollArea>
		</Paper>
	)
}

function FontManagerMappingsTab({ ctx }: { ctx: PluginExtensionContext }) {
	const { snapshot, loading, error, fetchSnapshot } = useFontManagerData()
	const [reloading, setReloading] = useState(false)
	const [savingKey, setSavingKey] = useState<string | null>(null)

	const handleReload = async () => {
		setReloading(true)
		try {
			await rpc().reload('ui')
			await fetchSnapshot()
		} finally {
			setReloading(false)
		}
	}

	const handleSavePreferred = async (key: string, families: string[]) => {
		setSavingKey(key)
		try {
			await rpc().setPreferred(key, families)
			await fetchSnapshot()
		} finally {
			setSavingKey(null)
		}
	}

	return (
		<Stack gap="md">
			{error ? (
				<Alert icon={<IconAlertCircle size={16} />} color="red">
					{error}
				</Alert>
			) : null}
			<Overview snapshot={snapshot} onReload={handleReload} reloading={reloading} />
			{snapshot ? (
				<PreferredEditor
					resolved={snapshot.resolved}
					aliases={snapshot.aliases}
					families={snapshot.families}
					onSave={handleSavePreferred}
					saving={savingKey}
				/>
			) : null}
		</Stack>
	)
}

function FontManagerLibraryTab({ ctx }: { ctx: PluginExtensionContext }) {
	const { snapshot, loading, error, fetchSnapshot } = useFontManagerData()
	const [reloading, setReloading] = useState(false)

	const handleReload = async () => {
		setReloading(true)
		try {
			await rpc().reload('ui-library')
			await fetchSnapshot()
		} finally {
			setReloading(false)
		}
	}

	return (
		<Stack gap="md">
			<Group justify="space-between" align="center">
				<Text fw={600} size="lg">
					字体库
				</Text>
				<Button size="xs" variant="light" loading={reloading} onClick={handleReload}>
					刷新字体
				</Button>
			</Group>
			{error ? (
				<Alert icon={<IconAlertCircle size={16} />} color="red">
					{error}
				</Alert>
			) : null}
			<Paper withBorder p="md" radius="md">
				<Group gap="xs" mb="sm">
					<IconFolder size={16} />
					<Text fw={600}>加载来源</Text>
					<Text size="xs" c="dimmed">
						展示检测到的系统目录与配置目录（如 /run/host/fonts/SourceHanSC）
					</Text>
				</Group>
				{loading && !snapshot ? (
					<Group justify="center" py="md">
						<Loader size="sm" />
					</Group>
				) : (
					<Sources sources={snapshot?.sources ?? []} />
				)}
			</Paper>
			{snapshot ? (
				<FontsLibrary families={snapshot.families} loading={loading} />
			) : (
				<Paper withBorder p="md" radius="md">
					<Group justify="center" py="md">
						{loading ? <Loader size="sm" /> : <Text size="sm">暂无字体数据</Text>}
					</Group>
				</Paper>
			)}
		</Stack>
	)
}

const module = definePluginUIModule({
	extensions: [
		{
			point: 'plugin:tabs',
			id: 'font-library',
			priority: 16,
			meta: { label: '字体库' },
			when: (ctx) => ctx.pluginName === 'FontManager',
			Component: FontManagerLibraryTab,
		},
		{
			point: 'plugin:tabs',
			id: 'font-mappings',
			priority: 15,
			meta: { label: '字体映射' },
			when: (ctx) => ctx.pluginName === 'FontManager',
			Component: FontManagerMappingsTab,
		},
	],
})

export default module
