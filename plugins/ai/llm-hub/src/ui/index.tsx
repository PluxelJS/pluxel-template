import {
	ActionIcon,
	Badge,
	Button,
	Card,
	Code,
	Group,
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
	IconKey,
	IconKeyOff,
	IconPencil,
	IconRefresh,
	IconStar,
	IconToggleLeft,
	IconToggleRight,
	IconTrash,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { LLMHubRequest, LLMHubResponse } from '../rpc'
import type { LLMHubSettingsDoc } from '../settings'
import type { LLMProfilePublic } from '../profiles'

type RequestFn = <T extends LLMHubRequest>(req: T) => Promise<LLMHubResponse<T>>

type RuntimeApi = Readonly<{
	pluginName: string
	request: RequestFn
}>

function useRuntime(): RuntimeApi {
	const ctx = useExtensionContext('plugin')
	// Root cause note:
	// - RPC extension namespaces are keyed by `ctx.pluginInfo.id` on the host (`RpcService.registerExtension`).
	// - So the UI must call `ctx.services.hmr.ui[ctx.pluginName].*`, not a hardcoded name.
	const namespace = ctx.pluginName
	const ui = (ctx.services.hmr.ui as any)?.[namespace] as { request?: RequestFn } | undefined
	const request = useCallback<RequestFn>(
		async (req) => {
			if (!ui || typeof ui.request !== 'function') {
				throw new Error(
					`LLMHub RPC not available: ctx.services.hmr.ui["${namespace}"].request is missing. Is "${namespace}" running and did it register ext.rpc?`,
				)
			}
			return (await ui.request(req as any)) as any
		},
		[namespace, ui],
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
	const [settingsMode, setSettingsMode] = useState<'default-first' | 'priority-first'>('default-first')
	const [settingsFallback, setSettingsFallback] = useState(true)
	const [settingsCircuitEnabled, setSettingsCircuitEnabled] = useState(true)
	const [settingsCircuitFailureThreshold, setSettingsCircuitFailureThreshold] = useState<number>(3)
	const [settingsCircuitOpenSeconds, setSettingsCircuitOpenSeconds] = useState<number>(30)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const [createOpen, setCreateOpen] = useState(false)
	const [createTitle, setCreateTitle] = useState('')
	const [createProvider, setCreateProvider] = useState('openai')
	const [createModel, setCreateModel] = useState('gpt-4o-mini')
	const [createBaseURL, setCreateBaseURL] = useState('')
	const [createApiKey, setCreateApiKey] = useState('')
	const [createPriority, setCreatePriority] = useState<number>(0)
	const [createCircuitEnabled, setCreateCircuitEnabled] = useState(true)
	const [createFailureThreshold, setCreateFailureThreshold] = useState<number>(3)
	const [createOpenSeconds, setCreateOpenSeconds] = useState<number>(30)
	const [createConfigJson, setCreateConfigJson] = useState('{}')
	const [createOptionsJson, setCreateOptionsJson] = useState('{}')
	const [createMakeDefault, setCreateMakeDefault] = useState(true)

	const [editOpen, setEditOpen] = useState(false)
	const [editId, setEditId] = useState<string | null>(null)
	const [editTitle, setEditTitle] = useState('')
	const [editProvider, setEditProvider] = useState('')
	const [editModel, setEditModel] = useState('')
	const [editBaseURL, setEditBaseURL] = useState('')
	const [editEnabled, setEditEnabled] = useState(true)
	const [editPriority, setEditPriority] = useState<number>(0)
	const [editCircuitEnabled, setEditCircuitEnabled] = useState(true)
	const [editFailureThreshold, setEditFailureThreshold] = useState<number>(3)
	const [editOpenSeconds, setEditOpenSeconds] = useState<number>(30)
	const [editConfigJson, setEditConfigJson] = useState('{}')
	const [editOptionsJson, setEditOptionsJson] = useState('{}')

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
		setSettingsMode(settings.selection?.mode ?? 'default-first')
		setSettingsFallback(settings.selection?.fallback ?? true)
		setSettingsCircuitEnabled(settings.circuit?.enabled ?? true)
		setSettingsCircuitFailureThreshold(settings.circuit?.failureThreshold ?? 3)
		setSettingsCircuitOpenSeconds(Math.round((settings.circuit?.openMs ?? 30_000) / 1000))
	}, [settings])

	const saveSettings = useCallback(async () => {
		try {
			const res = await request({
				type: 'settings:update',
				input: {
					selection: { mode: settingsMode, fallback: settingsFallback },
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
	}, [request, settingsCircuitEnabled, settingsCircuitFailureThreshold, settingsCircuitOpenSeconds, settingsFallback, settingsMode])

	const createProfile = useCallback(async () => {
		try {
			const config = parseJsonObject('Config', createConfigJson)
			const options = parseJsonObject('Options', createOptionsJson)

			const res = await request({
				type: 'profiles:create',
				input: {
					title: createTitle.trim() || undefined,
					provider: createProvider,
					model: createModel.trim() || undefined,
					baseURL: createBaseURL.trim() || undefined,
					priority: createPriority,
					circuit: {
						enabled: createCircuitEnabled,
						failureThreshold: createFailureThreshold,
						openMs: Math.max(1, Math.trunc(createOpenSeconds)) * 1000,
					},
					config,
					options,
					apiKey: createApiKey.trim() || undefined,
					makeDefault: createMakeDefault,
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
		createMakeDefault,
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
			setEditId(p.id)
			setEditTitle(p.title ?? '')
			setEditProvider(p.provider ?? '')
			setEditModel(p.model ?? '')
			setEditBaseURL(p.baseURL ?? '')
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
			const config = parseJsonObject('Config', editConfigJson)
			const options = parseJsonObject('Options', editOptionsJson)

			const res = await request({
				type: 'profiles:update',
				id: editId,
				input: {
					enabled: editEnabled,
					title: editTitle.trim() || undefined,
					provider: editProvider,
					model: editModel.trim() || undefined,
					baseURL: editBaseURL.trim() || undefined,
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
		editModel,
		editOpenSeconds,
		editOptionsJson,
		editPriority,
		editProvider,
		editTitle,
		refresh,
		request,
	])

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
					<Button size="xs" leftSection={<IconCirclePlus size={14} />} onClick={() => setCreateOpen(true)}>
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

			{settings ? (
				<Card withBorder radius="md" p="md">
					<Group justify="space-between" align="center">
						<Group gap="xs">
							<Text fw={600}>Policy</Text>
							<Badge variant="light" color="gray">
								<Code>routing</Code>
							</Badge>
						</Group>
						<Button size="xs" variant="light" onClick={() => void saveSettings()}>
							Save
						</Button>
					</Group>
					<Group mt="sm" grow align="end">
						<Select
							label="Selection mode"
							data={[
								{ value: 'default-first', label: 'Default first' },
								{ value: 'priority-first', label: 'Priority first' },
							]}
							value={settingsMode}
							onChange={(v) => setSettingsMode(v === 'priority-first' ? 'priority-first' : 'default-first')}
						/>
						<Switch label="Allow fallback" checked={settingsFallback} onChange={(e) => setSettingsFallback(e.currentTarget.checked)} />
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
				</Card>
			) : null}

			{profiles.map((p) => {
				const openUntil = p.health?.openUntil
				const overrideEnabled = p.circuit?.enabled
				const globalEnabled = settings?.circuit?.enabled ?? true
				const circuitEnabled = overrideEnabled === undefined ? globalEnabled : overrideEnabled !== false
				const isOpen = circuitEnabled && typeof openUntil === 'number' && openUntil > Date.now()

				return (
					<Card key={p.id} withBorder radius="md" p="md">
						<Group justify="space-between" align="center">
							<Stack gap={4}>
								<Group gap="xs">
									<Text fw={600}>{p.title ?? p.provider}</Text>
									{p.isDefault ? (
										<Badge leftSection={<IconStar size={12} />} color="yellow" variant="light">
											Default
										</Badge>
									) : null}
									{p.enabled ? (
										<Badge color="teal" variant="light">
											Enabled
										</Badge>
									) : (
										<Badge color="gray" variant="light">
											Disabled
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
							<Group gap="xs">
								<ActionIcon variant="light" aria-label="编辑" onClick={() => openEdit(p)}>
									<IconPencil size={16} />
								</ActionIcon>
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
								<ActionIcon
									variant="light"
									aria-label="设为默认"
									onClick={async () => {
										try {
											const r = await request({ type: 'profiles:setDefault', id: p.id })
											if (!r.ok) return setError(errorMessage(r.err, '无法设为默认'))
											await refresh()
										} catch (e) {
											setError(rpcErrorMessage(e, '无法设为默认'))
										}
									}}
								>
									<IconStar size={16} />
								</ActionIcon>
								<ActionIcon
									variant="light"
									aria-label="重置熔断/健康"
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
									<IconRefresh size={16} />
								</ActionIcon>
								<ActionIcon
									variant="light"
									aria-label="设置 API key"
									onClick={async () => {
										const next = window.prompt('API key（将安全写入 Vault）', '')
										if (!next) return
										try {
											const r = await request({ type: 'profiles:setApiKey', id: p.id, apiKey: next })
											if (!r.ok) return setError(errorMessage(r.err, '无法设置 API key'))
											await refresh()
										} catch (e) {
											setError(rpcErrorMessage(e, '无法设置 API key'))
										}
									}}
								>
									<IconKey size={16} />
								</ActionIcon>
								<ActionIcon
									variant="light"
									aria-label="清除 API key"
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
									<IconKeyOff size={16} />
								</ActionIcon>
								<ActionIcon
									variant="light"
									color="red"
									aria-label="删除"
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
									<IconTrash size={16} />
								</ActionIcon>
							</Group>
						</Group>
					</Card>
				)
			})}

			<Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Create LLM Profile">
				<Stack gap="sm">
					<TextInput label="Title (optional)" value={createTitle} onChange={(e) => setCreateTitle(e.currentTarget.value)} />
					<TextInput label="Provider" value={createProvider} onChange={(e) => setCreateProvider(e.currentTarget.value)} />
					<TextInput label="Model" value={createModel} onChange={(e) => setCreateModel(e.currentTarget.value)} />
					<TextInput
						label="baseURL (optional)"
						value={createBaseURL}
						onChange={(e) => setCreateBaseURL(e.currentTarget.value)}
						placeholder="https://api.openai.com/v1"
					/>
					<NumberInput label="Priority" value={createPriority} onChange={(v) => setCreatePriority(Number(v) || 0)} />
					<Group grow>
						<Switch label="Circuit enabled" checked={createCircuitEnabled} onChange={(e) => setCreateCircuitEnabled(e.currentTarget.checked)} />
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
					<TextInput
						label="API key"
						leftSection={<IconKey size={14} />}
						type="password"
						value={createApiKey}
						onChange={(e) => setCreateApiKey(e.currentTarget.value)}
					/>
					<Switch label="Set as default" checked={createMakeDefault} onChange={(e) => setCreateMakeDefault(e.currentTarget.checked)} />
					<Group justify="flex-end">
						<Button variant="light" onClick={() => setCreateOpen(false)}>
							Cancel
						</Button>
						<Button onClick={() => void createProfile()}>Create</Button>
					</Group>
				</Stack>
			</Modal>

			<Modal opened={editOpen} onClose={() => setEditOpen(false)} title="Edit LLM Profile">
				<Stack gap="sm">
					<TextInput label="Title (optional)" value={editTitle} onChange={(e) => setEditTitle(e.currentTarget.value)} />
					<TextInput label="Provider" value={editProvider} onChange={(e) => setEditProvider(e.currentTarget.value)} />
					<TextInput label="Model" value={editModel} onChange={(e) => setEditModel(e.currentTarget.value)} />
					<TextInput
						label="baseURL (optional)"
						value={editBaseURL}
						onChange={(e) => setEditBaseURL(e.currentTarget.value)}
						placeholder="https://api.openai.com/v1"
					/>
					<Switch label="Enabled" checked={editEnabled} onChange={(e) => setEditEnabled(e.currentTarget.checked)} />
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
