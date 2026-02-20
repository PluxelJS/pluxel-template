import {
	Accordion,
	ActionIcon,
	Autocomplete,
	Badge,
	Button,
	Card,
	Code,
	Collapse,
	Divider,
	Group,
	Menu,
	Modal,
	NumberInput,
	Select,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Title,
} from '@mantine/core'
import { definePluginUIModule, ExtensionPoints, rpcErrorMessage, useExtensionContext } from '@pluxel/hmr/web'
import {
	IconCirclePlus,
	IconChevronDown,
	IconChevronUp,
	IconDots,
	IconKey,
	IconKeyOff,
	IconPencil,
	IconRefresh,
	IconToggleLeft,
	IconToggleRight,
	IconTrash,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { LLMHubRequest, LLMHubResponse } from '../rpc'
import type { LLMHubSettingsDoc } from '../settings'
import type { LLMProfilePublic } from '../profiles'
import { resolveModelListUrl } from '../models'
import { PRESET_OPTIONS, resolvePreset, DEFAULT_PROVIDER_PRESETS } from './presets'

type RequestFn = <T extends LLMHubRequest>(req: T) => Promise<LLMHubResponse<T>>

type RuntimeApi = Readonly<{
	pluginName: string
	request: RequestFn
}>

const PROVIDER_PRESETS = DEFAULT_PROVIDER_PRESETS

async function fetchModelList(input: {
	baseURL: string
	apiKey?: string
	modelListPath?: string | null
	profileId?: string
}) {
	const res = await fetch('/api/llm/models', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			baseURL: input.baseURL,
			apiKey: input.apiKey,
			modelListPath: input.modelListPath,
			profileId: input.profileId,
		}),
	})

	const payload = await res.json().catch(() => null)
	if (!res.ok || !payload || typeof payload !== 'object') {
		throw new Error(`models 拉取失败: ${res.status}`)
	}

	if (!(payload as any).ok) {
		const msg = typeof (payload as any).error === 'string' ? (payload as any).error : 'models 拉取失败'
		throw new Error(msg)
	}

	const models = Array.isArray((payload as any).models) ? ((payload as any).models as string[]) : []
	if (!models.length) throw new Error('models 列表为空或格式不识别')
	return [...new Set(models)].sort((a, b) => a.localeCompare(b))
}

function useRuntime(): RuntimeApi {
	const ctx = useExtensionContext('plugin')
	const { hmr } = ctx.services
	// Root cause note:
	// - RPC extension namespaces are keyed by `ctx.pluginInfo.id` on the host (`RpcService.registerExtension`).
	// - So the UI must call `ctx.services.hmr.ui[ctx.pluginName].*`, not a hardcoded name.
	const namespace = ctx.pluginName
	const request = useCallback<RequestFn>(
		async (req) => {
			const res = await (hmr.ui as any)[namespace].request(req as any)
			if (!res || typeof res !== 'object' || typeof (res as any).ok !== 'boolean') {
				throw new Error(
					`LLMHub RPC not available: ctx.services.hmr.ui["${namespace}"].request returned an invalid response. Is "${namespace}" running and did it register ext.rpc?`,
				)
			}
			return res as any
		},
		[hmr.ui, namespace],
	)
	return useMemo(() => ({ pluginName: ctx.pluginName, request }), [ctx.pluginName, request])
}

function errorMessage(err: unknown, fallback: string) {
	if (!err || typeof err !== 'object') return fallback
	const code = typeof (err as any).code === 'string' ? (err as any).code : ''
	const message = typeof (err as any).message === 'string' ? (err as any).message : fallback
	return code ? `${code}: ${message}` : message
}

function parseJsonObject(label: string, raw: string): Record<string, unknown> {
	const trimmed = String(raw ?? '').trim()
	if (!trimmed) return {}

	let val: unknown
	try {
		val = JSON.parse(trimmed)
	} catch (e) {
		const msg = typeof (e as any)?.message === 'string' ? (e as any).message : 'invalid json'
		throw new Error(`${label} JSON parse failed: ${msg}`)
	}

	if (!val || typeof val !== 'object' || Array.isArray(val)) throw new Error(`${label} must be a JSON object`)
	return val as Record<string, unknown>
}

function LLMProfilesPanel() {
	type Profile = LLMProfilePublic
	const { pluginName, request } = useRuntime()

	const [profiles, setProfiles] = useState<Profile[]>([])
	const [settings, setSettings] = useState<LLMHubSettingsDoc | null>(null)
	const [settingsCircuitEnabled, setSettingsCircuitEnabled] = useState(true)
	const [settingsCircuitFailureThreshold, setSettingsCircuitFailureThreshold] = useState<number>(3)
	const [settingsCircuitOpenSeconds, setSettingsCircuitOpenSeconds] = useState<number>(30)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const [createOpen, setCreateOpen] = useState(false)
	const [createPresetId, setCreatePresetId] = useState('openai')
	const [createTitle, setCreateTitle] = useState('')
	const [createProvider, setCreateProvider] = useState('openai')
	const [createModel, setCreateModel] = useState('')
	const [createModelOptions, setCreateModelOptions] = useState<string[]>([])
	const [createModelLoading, setCreateModelLoading] = useState(false)
	const [createModelError, setCreateModelError] = useState<string | null>(null)
	const [createBaseURL, setCreateBaseURL] = useState('')
	const [createModelListEnabled, setCreateModelListEnabled] = useState(true)
	const [createModelListPath, setCreateModelListPath] = useState('')
	const [createApiKey, setCreateApiKey] = useState('')
	const [createPriority, setCreatePriority] = useState<number>(0)
	const [createCircuitEnabled, setCreateCircuitEnabled] = useState(true)
	const [createFailureThreshold, setCreateFailureThreshold] = useState<number>(3)
	const [createOpenSeconds, setCreateOpenSeconds] = useState<number>(30)
	const [createConfigJson, setCreateConfigJson] = useState('{}')
	const [createOptionsJson, setCreateOptionsJson] = useState('{}')

	const [editOpen, setEditOpen] = useState(false)
	const [editId, setEditId] = useState<string | null>(null)
	const [editPresetId, setEditPresetId] = useState('custom')
	const [editTitle, setEditTitle] = useState('')
	const [editProvider, setEditProvider] = useState('')
	const [editModel, setEditModel] = useState('')
	const [editModelOptions, setEditModelOptions] = useState<string[]>([])
	const [editModelLoading, setEditModelLoading] = useState(false)
	const [editModelError, setEditModelError] = useState<string | null>(null)
	const [editBaseURL, setEditBaseURL] = useState('')
	const [editModelListEnabled, setEditModelListEnabled] = useState(true)
	const [editModelListPath, setEditModelListPath] = useState('')
	const [editApiKey, setEditApiKey] = useState('')
	const [editEnabled, setEditEnabled] = useState(true)
	const [editPriority, setEditPriority] = useState<number>(0)
	const [editCircuitEnabled, setEditCircuitEnabled] = useState(true)
	const [editFailureThreshold, setEditFailureThreshold] = useState<number>(3)
	const [editOpenSeconds, setEditOpenSeconds] = useState<number>(30)
	const [editConfigJson, setEditConfigJson] = useState('{}')
	const [editOptionsJson, setEditOptionsJson] = useState('{}')

	const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})

	const refresh = useCallback(async () => {
		setLoading(true)
		try {
			const [listRes, settingsRes] = await Promise.all([request({ type: 'profiles:list' }), request({ type: 'settings:get' })])

			if (!listRes.ok) {
				setError(errorMessage(listRes.err, '无法获取 profiles'))
				setProfiles([])
				return
			}
			setProfiles(listRes.val)

			if (settingsRes.ok) setSettings(settingsRes.val)
			else setSettings(null)

			setError(null)
		} catch (e) {
			setError(rpcErrorMessage(e, '无法获取 profiles'))
		} finally {
			setLoading(false)
		}
	}, [request])

	useEffect(() => {
		void refresh()
	}, [refresh])

	useEffect(() => {
		if (!settings) return
		setSettingsCircuitEnabled(settings.circuit?.enabled ?? true)
		setSettingsCircuitFailureThreshold(settings.circuit?.failureThreshold ?? 3)
		setSettingsCircuitOpenSeconds(Math.round((settings.circuit?.openMs ?? 30_000) / 1000))
	}, [settings])

	const defaultCircuit = useMemo(
		() => ({
			enabled: settings?.circuit?.enabled ?? true,
			failureThreshold: settings?.circuit?.failureThreshold ?? 3,
			openSeconds: Math.round((settings?.circuit?.openMs ?? 30_000) / 1000),
		}),
		[settings],
	)

	const toggleDetails = useCallback((id: string) => {
		setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }))
	}, [])

	const applyCreatePreset = useCallback((presetId: string) => {
		const preset = resolvePreset(presetId)
		const isCustom = preset.id === 'custom'
		setCreateProvider(isCustom ? '' : preset.provider)
		setCreateBaseURL(preset.baseURL ?? '')
		setCreateModel(preset.modelHint ?? '')
		setCreateModelOptions([])
		setCreateModelError(null)
	}, [])

	const resetCreateForm = useCallback(() => {
		applyCreatePreset(createPresetId)
		setCreateTitle('')
		setCreateApiKey('')
		setCreateModelListEnabled(true)
		setCreateModelListPath('')
		setCreatePriority(0)
		setCreateCircuitEnabled(defaultCircuit.enabled)
		setCreateFailureThreshold(defaultCircuit.failureThreshold)
		setCreateOpenSeconds(defaultCircuit.openSeconds)
		setCreateConfigJson('{}')
		setCreateOptionsJson('{}')
	}, [
		applyCreatePreset,
		createPresetId,
		defaultCircuit.enabled,
		defaultCircuit.failureThreshold,
		defaultCircuit.openSeconds,
	])

	const handleCreatePresetChange = useCallback(
		(value: string | null) => {
			const nextId = value ?? 'custom'
			setCreatePresetId(nextId)
			applyCreatePreset(nextId)
		},
		[applyCreatePreset],
	)

	const handleEditPresetChange = useCallback((value: string | null) => {
		const nextId = value ?? 'custom'
		setEditPresetId(nextId)
		const preset = resolvePreset(nextId)
		if (preset.id !== 'custom') {
			setEditProvider(preset.provider)
			setEditBaseURL(preset.baseURL ?? '')
			setEditModel(preset.modelHint ?? '')
			setEditModelOptions([])
			setEditModelError(null)
		}
	}, [])

	const loadCreateModels = useCallback(async () => {
		const preset = resolvePreset(createPresetId)
		const baseURL = createBaseURL.trim() || preset.baseURL || ''
		setCreateModelLoading(true)
		setCreateModelError(null)
		try {
			const models = await fetchModelList({
				baseURL,
				apiKey: createApiKey,
				modelListPath: createModelListEnabled ? (createModelListPath.trim() || undefined) : null,
			})
			setCreateModelOptions(models)
			if (!createModel && models.length) setCreateModel(models[0])
		} catch (e) {
			setCreateModelError(errorMessage(e, 'models 拉取失败'))
		} finally {
			setCreateModelLoading(false)
		}
	}, [createApiKey, createBaseURL, createModel, createModelListEnabled, createModelListPath, createPresetId])

	const loadEditModels = useCallback(async () => {
		const preset = resolvePreset(editPresetId)
		const baseURL = editBaseURL.trim() || preset.baseURL || ''
		setEditModelLoading(true)
		setEditModelError(null)
		try {
			const models = await fetchModelList({
				baseURL,
				apiKey: editApiKey,
				modelListPath: editModelListEnabled ? (editModelListPath.trim() || undefined) : null,
				profileId: editId ?? undefined,
			})
			setEditModelOptions(models)
			if (!editModel && models.length) setEditModel(models[0])
		} catch (e) {
			setEditModelError(errorMessage(e, 'models 拉取失败'))
		} finally {
			setEditModelLoading(false)
		}
	}, [editApiKey, editBaseURL, editId, editModel, editModelListEnabled, editModelListPath, editPresetId])

	const openCreate = useCallback(() => {
		resetCreateForm()
		setCreateOpen(true)
	}, [resetCreateForm])

	const saveSettings = useCallback(async () => {
		try {
			const res = await request({
				type: 'settings:update',
				input: {
					circuit: {
						enabled: settingsCircuitEnabled,
						failureThreshold: settingsCircuitFailureThreshold,
						openMs: Math.max(1, Math.trunc(settingsCircuitOpenSeconds)) * 1000,
					},
				},
			})

			if (!res.ok) return setError(errorMessage(res.err, '无法保存设置'))
			setSettings(res.val)
			setError(null)
		} catch (e) {
			setError(rpcErrorMessage(e, '无法保存设置'))
		}
	}, [request, settingsCircuitEnabled, settingsCircuitFailureThreshold, settingsCircuitOpenSeconds])

	const createProfile = useCallback(async () => {
		try {
			const provider = createProvider.trim()
			if (!provider) {
				setError('Provider 不能为空')
				return
			}
			const config = parseJsonObject('Config', createConfigJson)
			const options = parseJsonObject('Options', createOptionsJson)

			const res = await request({
				type: 'profiles:create',
				input: {
					title: createTitle.trim() || undefined,
					provider,
					model: createModel.trim() || undefined,
					baseURL: createBaseURL.trim() || undefined,
					modelListPath: createModelListEnabled ? (createModelListPath.trim() || undefined) : null,
					priority: createPriority,
					circuit: {
						enabled: createCircuitEnabled,
						failureThreshold: createFailureThreshold,
						openMs: Math.max(1, Math.trunc(createOpenSeconds)) * 1000,
					},
					config,
					options,
					apiKey: createApiKey.trim() || undefined,
				},
			})
			if (!res.ok) return setError(errorMessage(res.err, '无法创建 profile'))
			setCreateApiKey('')
			setCreateOpen(false)
			await refresh()
		} catch (e) {
			setError(rpcErrorMessage(e, '无法创建 profile'))
		}
	}, [
		createApiKey,
		createBaseURL,
		createCircuitEnabled,
		createConfigJson,
		createFailureThreshold,
		createModelListEnabled,
		createModelListPath,
		createModel,
		createOpenSeconds,
		createOptionsJson,
		createPriority,
		createProvider,
		createTitle,
		refresh,
		request,
	])

	const openEdit = useCallback(
		(p: Profile) => {
			const matchedPreset = PROVIDER_PRESETS.find((preset) => preset.provider === p.provider)
			setEditPresetId(matchedPreset?.id ?? 'custom')
			setEditId(p.id)
			setEditTitle(p.title ?? '')
			setEditProvider(p.provider ?? '')
			setEditModel(p.model ?? '')
			setEditModelOptions([])
			setEditModelError(null)
			setEditBaseURL(p.baseURL ?? '')
			setEditModelListEnabled(p.modelListPath !== null)
			setEditModelListPath(typeof p.modelListPath === 'string' ? p.modelListPath : '')
			setEditApiKey('')
			setEditEnabled(!!p.enabled)
			setEditPriority(p.priority ?? 0)
			setEditCircuitEnabled(p.circuit?.enabled !== false)
			setEditFailureThreshold(
				typeof p.circuit?.failureThreshold === 'number' ? p.circuit.failureThreshold : (settings?.circuit?.failureThreshold ?? 3),
			)
			setEditOpenSeconds(
				Math.round((typeof p.circuit?.openMs === 'number' ? p.circuit.openMs : (settings?.circuit?.openMs ?? 30_000)) / 1000),
			)
			setEditConfigJson(JSON.stringify(p.config ?? {}, null, 2))
			setEditOptionsJson(JSON.stringify(p.options ?? {}, null, 2))
			setEditOpen(true)
		},
		[settings?.circuit?.failureThreshold, settings?.circuit?.openMs],
	)

	const saveEdit = useCallback(async () => {
		if (!editId) return
		try {
			const provider = editProvider.trim()
			if (!provider) {
				setError('Provider 不能为空')
				return
			}
			const config = parseJsonObject('Config', editConfigJson)
			const options = parseJsonObject('Options', editOptionsJson)

			const res = await request({
				type: 'profiles:update',
				id: editId,
				input: {
					enabled: editEnabled,
					title: editTitle.trim() || undefined,
					provider,
					model: editModel.trim() || undefined,
					baseURL: editBaseURL.trim() || undefined,
					modelListPath: editModelListEnabled ? (editModelListPath.trim() || undefined) : null,
					priority: editPriority,
					circuit: {
						enabled: editCircuitEnabled,
						failureThreshold: editFailureThreshold,
						openMs: Math.max(1, Math.trunc(editOpenSeconds)) * 1000,
					},
					config,
					options,
				},
			})
			if (!res.ok) return setError(errorMessage(res.err, '无法更新 profile'))

			const apiKey = editApiKey.trim()
			if (apiKey) {
				const keyRes = await request({ type: 'profiles:setApiKey', id: editId, apiKey })
				if (!keyRes.ok) return setError(errorMessage(keyRes.err, '无法设置 API key'))
			}

			setEditApiKey('')
			setEditOpen(false)
			await refresh()
		} catch (e) {
			setError(rpcErrorMessage(e, '无法更新 profile'))
		}
	}, [
		editBaseURL,
		editCircuitEnabled,
		editConfigJson,
		editEnabled,
		editFailureThreshold,
		editId,
		editModelListEnabled,
		editModelListPath,
		editModel,
		editOpenSeconds,
		editOptionsJson,
		editPriority,
		editProvider,
		editTitle,
		editApiKey,
		refresh,
		request,
	])

	const createPreset = resolvePreset(createPresetId)
	const editPreset = resolvePreset(editPresetId)
	const createModelListUrl = resolveModelListUrl(
		createBaseURL.trim() || createPreset.baseURL || '',
		createModelListEnabled ? (createModelListPath.trim() || undefined) : null,
	)
	const editModelListUrl = resolveModelListUrl(
		editBaseURL.trim() || editPreset.baseURL || '',
		editModelListEnabled ? (editModelListPath.trim() || undefined) : null,
	)
	const showCreateBaseURL = createPreset.id === 'custom' || !createPreset.baseURL
	const showEditBaseURL = editPreset.id === 'custom' || !editPreset.baseURL

	return (
		<Stack gap="md">
			<Group justify="space-between" align="center">
				<Group gap="xs">
					<Title order={4}>LLM Profiles</Title>
					<Badge variant="light" color="gray">
						<Code>{pluginName}</Code>
					</Badge>
				</Group>
				<Group gap="xs">
					<ActionIcon variant="light" onClick={() => void refresh()} aria-label="刷新">
						<IconRefresh size={16} />
					</ActionIcon>
					<Button size="xs" leftSection={<IconCirclePlus size={14} />} onClick={openCreate}>
						New
					</Button>
				</Group>
			</Group>

			{error ? (
				<Card withBorder radius="md" p="md">
					<Text c="red" size="sm">
						{error}
					</Text>
				</Card>
			) : null}

			{loading ? (
				<Text size="sm" c="dimmed">
					Loading…
				</Text>
			) : null}

			{!loading && !error && profiles.length === 0 ? (
				<Card withBorder radius="md" p="md">
					<Stack gap={6}>
						<Text fw={600}>No profiles yet</Text>
						<Text size="sm" c="dimmed">
							Click <Code>New</Code> to create your first LLM profile. Provider presets can auto-fill baseURL and fetch models. API keys
							are stored in Vault; only a masked preview is shown here.
						</Text>
						<Group>
							<Button size="xs" variant="light" leftSection={<IconCirclePlus size={14} />} onClick={openCreate}>
								Create profile
							</Button>
						</Group>
					</Stack>
				</Card>
			) : null}

			{settings ? (
				<Accordion variant="contained" radius="md">
					<Accordion.Item value="circuit">
						<Accordion.Control>
							<Group gap="xs">
								<Text fw={600}>Circuit Breaker</Text>
								<Badge variant="light" color="gray">
									<Code>defaults</Code>
								</Badge>
							</Group>
						</Accordion.Control>
						<Accordion.Panel>
							<Group justify="flex-end">
								<Button size="xs" variant="light" onClick={() => void saveSettings()}>
									Save
								</Button>
							</Group>
							<Group mt="sm" grow align="end">
								<Switch
									label="Circuit enabled"
									checked={settingsCircuitEnabled}
									onChange={(e) => setSettingsCircuitEnabled(e.currentTarget.checked)}
								/>
								<NumberInput
									label="Failure threshold"
									value={settingsCircuitFailureThreshold}
									min={1}
									max={100}
									onChange={(v) => setSettingsCircuitFailureThreshold(Number(v) || 1)}
								/>
								<NumberInput
									label="Open seconds"
									value={settingsCircuitOpenSeconds}
									min={1}
									max={3600}
									onChange={(v) => setSettingsCircuitOpenSeconds(Number(v) || 1)}
								/>
							</Group>
						</Accordion.Panel>
					</Accordion.Item>
				</Accordion>
			) : null}

			{profiles.map((p) => {
				const openUntil = p.health?.openUntil
				const overrideEnabled = p.circuit?.enabled
				const globalEnabled = settings?.circuit?.enabled ?? true
				const circuitEnabled = overrideEnabled === undefined ? globalEnabled : overrideEnabled !== false
				const isOpen = circuitEnabled && typeof openUntil === 'number' && openUntil > Date.now()
				const detailsOpen = !!expandedIds[p.id]

				return (
					<Card key={p.id} withBorder radius="md" p="md">
						<Group justify="space-between" align="center">
							<Stack gap={6}>
								<Group gap="xs">
									<Text fw={600}>{p.title ?? p.provider}</Text>
									{p.enabled ? (
										<Badge color="teal" variant="light">
											Enabled
										</Badge>
									) : (
										<Badge color="gray" variant="light">
											Disabled
										</Badge>
									)}
									{p.hasApiKey ? (
										<Badge color="blue" variant="light">
											Key set
										</Badge>
									) : (
										<Badge color="orange" variant="light">
											Key missing
										</Badge>
									)}
									{isOpen ? (
										<Badge color="red" variant="light">
											Circuit Open
										</Badge>
									) : (
										<Badge color="gray" variant="light">
											Healthy
										</Badge>
									)}
								</Group>
								<Text size="sm" c="dimmed">
									{p.provider}
									{p.model ? ` · ${p.model}` : ''}
									{p.baseURL ? ` · ${p.baseURL}` : ''}
								</Text>
							</Stack>
							<Group gap="xs">
								<ActionIcon
									variant="light"
									aria-label={p.enabled ? '禁用' : '启用'}
									onClick={async () => {
										try {
											const r = await request({ type: 'profiles:update', id: p.id, input: { enabled: !p.enabled } })
											if (!r.ok) return setError(errorMessage(r.err, '无法更新 enabled'))
											await refresh()
										} catch (e) {
											setError(rpcErrorMessage(e, '无法更新 enabled'))
										}
									}}
								>
									{p.enabled ? <IconToggleRight size={16} /> : <IconToggleLeft size={16} />}
								</ActionIcon>
								<ActionIcon variant="light" aria-label="详情" onClick={() => toggleDetails(p.id)}>
									{detailsOpen ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
								</ActionIcon>
								<Menu shadow="md" width={200} position="bottom-end">
									<Menu.Target>
										<ActionIcon variant="light" aria-label="更多">
											<IconDots size={16} />
										</ActionIcon>
									</Menu.Target>
									<Menu.Dropdown>
										<Menu.Item leftSection={<IconPencil size={14} />} onClick={() => openEdit(p)}>
											Edit
										</Menu.Item>
										<Menu.Item leftSection={<IconKey size={14} />} onClick={() => openEdit(p)}>
											Set API key
										</Menu.Item>
										<Menu.Item
											leftSection={<IconKeyOff size={14} />}
											onClick={async () => {
												try {
													const r = await request({ type: 'profiles:clearApiKey', id: p.id })
													if (!r.ok) return setError(errorMessage(r.err, '无法清除 API key'))
													await refresh()
												} catch (e) {
													setError(rpcErrorMessage(e, '无法清除 API key'))
												}
											}}
										>
											Clear API key
										</Menu.Item>
										<Menu.Item
											leftSection={<IconRefresh size={14} />}
											onClick={async () => {
												try {
													const r = await request({ type: 'profiles:resetHealth', id: p.id })
													if (!r.ok) return setError(errorMessage(r.err, '无法重置健康状态'))
													await refresh()
												} catch (e) {
													setError(rpcErrorMessage(e, '无法重置健康状态'))
												}
											}}
										>
											Reset health
										</Menu.Item>
										<Menu.Item
											color="red"
											leftSection={<IconTrash size={14} />}
											onClick={async () => {
												const yes = window.confirm(`Delete profile "${p.title ?? p.provider}"?`)
												if (!yes) return
												try {
													const r = await request({ type: 'profiles:delete', id: p.id })
													if (!r.ok) return setError(errorMessage(r.err, '无法删除 profile'))
													await refresh()
												} catch (e) {
													setError(rpcErrorMessage(e, '无法删除 profile'))
												}
											}}
										>
											Delete
										</Menu.Item>
									</Menu.Dropdown>
								</Menu>
							</Group>
						</Group>
						<Collapse in={detailsOpen}>
							<Divider my="sm" />
							<Stack gap={4}>
								<Text size="xs" c="dimmed">
									provider: <Code>{p.provider}</Code> {p.model ? <>model: <Code>{p.model}</Code></> : null}{' '}
									{p.baseURL ? <>baseURL: <Code>{p.baseURL}</Code></> : null}
								</Text>
								<Text size="xs" c="dimmed">
									priority: <Code>{p.priority ?? 0}</Code> circuit: <Code>{circuitEnabled ? 'on' : 'off'}</Code>
									{isOpen ? (
										<>
											{' '}
											until: <Code>{new Date(openUntil).toLocaleString()}</Code>
										</>
									) : null}
								</Text>
								<Text size="xs" c="dimmed">
									config: <Code>{p.configKeys.length ? p.configKeys.join(', ') : '∅'}</Code> options:{' '}
									<Code>{p.optionsKeys.length ? p.optionsKeys.join(', ') : '∅'}</Code>
								</Text>
								<Text size="xs" c="dimmed">
									apiKey: <Code>{p.hasApiKey ? p.apiKeyPreview ?? 'set' : 'missing'}</Code>
								</Text>
							</Stack>
						</Collapse>
					</Card>
				)
			})}

			<Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Create LLM Profile" size="lg">
				<Stack gap="sm">
					<Select label="Provider preset" data={PRESET_OPTIONS} value={createPresetId} onChange={handleCreatePresetChange} />
					{createPreset.note ? (
						<Text size="xs" c="dimmed">
							{createPreset.note}
						</Text>
					) : null}
					<TextInput label="Title (optional)" value={createTitle} onChange={(e) => setCreateTitle(e.currentTarget.value)} />
					<TextInput
						label="Provider id"
						value={createProvider}
						onChange={(e) => setCreateProvider(e.currentTarget.value)}
						disabled={createPreset.id !== 'custom'}
					/>
					{showCreateBaseURL ? (
						<TextInput
							label="Base URL"
							value={createBaseURL}
							onChange={(e) => setCreateBaseURL(e.currentTarget.value)}
							placeholder="https://api.openai.com/v1"
						/>
					) : null}
					<Group align="end" grow>
						<Autocomplete
							label="Model"
							value={createModel}
							onChange={setCreateModel}
							data={createModelOptions}
							placeholder={createPreset.modelHint ?? 'e.g. gpt-4o-mini'}
						/>
						<Button
							variant="light"
							loading={createModelLoading}
							disabled={!createModelListUrl}
							onClick={() => void loadCreateModels()}
						>
							Fetch models
						</Button>
					</Group>
					{createModelError ? (
						<Text size="xs" c="red">
							{createModelError}
						</Text>
					) : null}
					{!createModelListUrl ? (
						<Text size="xs" c="dimmed">
							无法自动拉取 models（需要 Base URL 且启用 Model list）。默认请求 OpenAI-compatible `/models`，可在 Advanced 中调整路径或关闭。
						</Text>
					) : null}
					<TextInput
						label="API key"
						leftSection={<IconKey size={14} />}
						type="password"
						value={createApiKey}
						onChange={(e) => setCreateApiKey(e.currentTarget.value)}
						description="留空时将创建无 key 的 profile（仅适用于无需鉴权的代理）。"
					/>

					<Accordion variant="contained" radius="md">
						<Accordion.Item value="advanced">
							<Accordion.Control>Advanced</Accordion.Control>
							<Accordion.Panel>
								<Stack gap="sm">
									{!showCreateBaseURL ? (
										<TextInput
											label="Base URL override (optional)"
											value={createBaseURL}
											onChange={(e) => setCreateBaseURL(e.currentTarget.value)}
											placeholder={createPreset.baseURL ?? 'https://api.openai.com/v1'}
										/>
									) : null}
									<Group grow align="end">
										<Switch
											label="Model list enabled"
											checked={createModelListEnabled}
											onChange={(e) => setCreateModelListEnabled(e.currentTarget.checked)}
										/>
										<TextInput
											label="Model list path (optional)"
											value={createModelListPath}
											onChange={(e) => setCreateModelListPath(e.currentTarget.value)}
											disabled={!createModelListEnabled}
											placeholder="/models"
										/>
									</Group>
									<NumberInput label="Priority" value={createPriority} onChange={(v) => setCreatePriority(Number(v) || 0)} />
									<Group grow>
										<Switch
											label="Circuit enabled"
											checked={createCircuitEnabled}
											onChange={(e) => setCreateCircuitEnabled(e.currentTarget.checked)}
										/>
										<NumberInput
											label="Failure threshold"
											value={createFailureThreshold}
											min={1}
											max={100}
											onChange={(v) => setCreateFailureThreshold(Number(v) || 1)}
										/>
										<NumberInput
											label="Open seconds"
											value={createOpenSeconds}
											min={1}
											max={3600}
											onChange={(v) => setCreateOpenSeconds(Number(v) || 1)}
										/>
									</Group>
									<Textarea
										label="Config (JSON)"
										autosize
										minRows={2}
										maxRows={6}
										value={createConfigJson}
										onChange={(e) => setCreateConfigJson(e.currentTarget.value)}
									/>
									<Textarea
										label="Options (JSON)"
										autosize
										minRows={2}
										maxRows={6}
										value={createOptionsJson}
										onChange={(e) => setCreateOptionsJson(e.currentTarget.value)}
									/>
								</Stack>
							</Accordion.Panel>
						</Accordion.Item>
					</Accordion>

					<Group justify="flex-end">
						<Button variant="light" onClick={() => setCreateOpen(false)}>
							Cancel
						</Button>
						<Button onClick={() => void createProfile()}>Create</Button>
					</Group>
				</Stack>
			</Modal>

			<Modal opened={editOpen} onClose={() => setEditOpen(false)} title="Edit LLM Profile" size="lg">
				<Stack gap="sm">
					<Select label="Provider preset" data={PRESET_OPTIONS} value={editPresetId} onChange={handleEditPresetChange} />
					{editPreset.note ? (
						<Text size="xs" c="dimmed">
							{editPreset.note}
						</Text>
					) : null}
					<Group grow align="end">
						<TextInput label="Title (optional)" value={editTitle} onChange={(e) => setEditTitle(e.currentTarget.value)} />
						<Switch label="Enabled" checked={editEnabled} onChange={(e) => setEditEnabled(e.currentTarget.checked)} />
					</Group>
					<TextInput
						label="Provider id"
						value={editProvider}
						onChange={(e) => setEditProvider(e.currentTarget.value)}
						disabled={editPreset.id !== 'custom'}
					/>
					{showEditBaseURL ? (
						<TextInput
							label="Base URL"
							value={editBaseURL}
							onChange={(e) => setEditBaseURL(e.currentTarget.value)}
							placeholder="https://api.openai.com/v1"
						/>
					) : null}
					<Group align="end" grow>
						<Autocomplete
							label="Model"
							value={editModel}
							onChange={setEditModel}
							data={editModelOptions}
							placeholder={editPreset.modelHint ?? 'e.g. gpt-4o-mini'}
						/>
						<Button
							variant="light"
							loading={editModelLoading}
							disabled={!editModelListUrl}
							onClick={() => void loadEditModels()}
						>
							Fetch models
						</Button>
					</Group>
					{editModelError ? (
						<Text size="xs" c="red">
							{editModelError}
						</Text>
					) : null}
					{!editModelListUrl ? (
						<Text size="xs" c="dimmed">
							无法自动拉取 models（需要 Base URL 且启用 Model list）。默认请求 OpenAI-compatible `/models`，可在 Advanced 中调整路径或关闭。
						</Text>
					) : null}
					<Group grow align="end">
						<TextInput
							label="API key"
							leftSection={<IconKey size={14} />}
							type="password"
							value={editApiKey}
							onChange={(e) => setEditApiKey(e.currentTarget.value)}
							description="留空表示不修改；保存时才会写入 Vault。"
						/>
						<Button
							variant="light"
							color="red"
							leftSection={<IconKeyOff size={14} />}
							onClick={async () => {
								if (!editId) return
								try {
									const r = await request({ type: 'profiles:clearApiKey', id: editId })
									if (!r.ok) return setError(errorMessage(r.err, '无法清除 API key'))
									await refresh()
								} catch (e) {
									setError(rpcErrorMessage(e, '无法清除 API key'))
								}
							}}
						>
							Clear key
						</Button>
					</Group>

					<Accordion variant="contained" radius="md">
						<Accordion.Item value="advanced">
							<Accordion.Control>Advanced</Accordion.Control>
							<Accordion.Panel>
								<Stack gap="sm">
									{!showEditBaseURL ? (
										<TextInput
											label="Base URL override (optional)"
											value={editBaseURL}
											onChange={(e) => setEditBaseURL(e.currentTarget.value)}
											placeholder={editPreset.baseURL ?? 'https://api.openai.com/v1'}
										/>
									) : null}
									<Group grow align="end">
										<Switch
											label="Model list enabled"
											checked={editModelListEnabled}
											onChange={(e) => setEditModelListEnabled(e.currentTarget.checked)}
										/>
										<TextInput
											label="Model list path (optional)"
											value={editModelListPath}
											onChange={(e) => setEditModelListPath(e.currentTarget.value)}
											disabled={!editModelListEnabled}
											placeholder="/models"
										/>
									</Group>
									<NumberInput label="Priority" value={editPriority} onChange={(v) => setEditPriority(Number(v) || 0)} />
									<Group grow>
										<Switch label="Circuit enabled" checked={editCircuitEnabled} onChange={(e) => setEditCircuitEnabled(e.currentTarget.checked)} />
										<NumberInput
											label="Failure threshold"
											value={editFailureThreshold}
											min={1}
											max={100}
											onChange={(v) => setEditFailureThreshold(Number(v) || 1)}
										/>
										<NumberInput
											label="Open seconds"
											value={editOpenSeconds}
											min={1}
											max={3600}
											onChange={(v) => setEditOpenSeconds(Number(v) || 1)}
										/>
									</Group>
									<Textarea
										label="Config (JSON)"
										autosize
										minRows={2}
										maxRows={8}
										value={editConfigJson}
										onChange={(e) => setEditConfigJson(e.currentTarget.value)}
									/>
									<Textarea
										label="Options (JSON)"
										autosize
										minRows={2}
										maxRows={8}
										value={editOptionsJson}
										onChange={(e) => setEditOptionsJson(e.currentTarget.value)}
									/>
								</Stack>
							</Accordion.Panel>
						</Accordion.Item>
					</Accordion>

					<Group justify="flex-end">
						<Button variant="light" onClick={() => setEditOpen(false)}>
							Cancel
						</Button>
						<Button onClick={() => void saveEdit()}>Save</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	)
}

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.PluginTabs,
			id: 'llm-profiles',
			priority: 50,
			meta: { label: 'LLM' },
			requireRunning: true,
			render: () => <LLMProfilesPanel />,
		},
	],
	setup({ pluginName }) {
		console.log(`[${pluginName}] LLM UI loaded`)
	},
})
