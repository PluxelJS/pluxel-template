import {
	ActionIcon,
	Badge,
	Button,
	Card,
	Code,
	Group,
	Modal,
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

import type { AxProfilePublic } from '../profiles'

type RuntimeApi = Readonly<{
	pluginName: string
	ui: ReturnType<typeof useExtensionContext>['services']['hmr']['ui']['Ax']
}>

function useRuntime(): RuntimeApi {
	const ctx = useExtensionContext('plugin')
	return useMemo(() => ({ pluginName: ctx.pluginName, ui: ctx.services.hmr.ui.Ax }), [ctx])
}

function AxProfilesPanel() {
	const { pluginName, ui } = useRuntime()
	type Profile = AxProfilePublic

	const [profiles, setProfiles] = useState<Profile[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const [createOpen, setCreateOpen] = useState(false)
	const [createTitle, setCreateTitle] = useState('')
	const [createProvider, setCreateProvider] = useState('openai')
	const [createModel, setCreateModel] = useState('gpt-4o-mini')
	const [createApiURL, setCreateApiURL] = useState('')
	const [createApiKey, setCreateApiKey] = useState('')
	const [createConfigJson, setCreateConfigJson] = useState('{}')
	const [createOptionsJson, setCreateOptionsJson] = useState('{}')
	const [createMakeDefault, setCreateMakeDefault] = useState(true)

	const [editOpen, setEditOpen] = useState(false)
	const [editId, setEditId] = useState<string | null>(null)
	const [editTitle, setEditTitle] = useState('')
	const [editProvider, setEditProvider] = useState('')
	const [editModel, setEditModel] = useState('')
	const [editApiURL, setEditApiURL] = useState('')
	const [editEnabled, setEditEnabled] = useState(true)
	const [editConfigJson, setEditConfigJson] = useState('{}')
	const [editOptionsJson, setEditOptionsJson] = useState('{}')

	const refresh = useCallback(async () => {
		setLoading(true)
		try {
			const list = await ui.request({ type: 'profiles:list' })
			setProfiles(list)
			setError(null)
		} catch (e) {
			setError(rpcErrorMessage(e, '无法获取 profiles'))
		} finally {
			setLoading(false)
		}
	}, [ui])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const createProfile = async () => {
		try {
			const config = createConfigJson.trim() ? JSON.parse(createConfigJson) : {}
			const options = createOptionsJson.trim() ? JSON.parse(createOptionsJson) : {}

			await ui.request({
				type: 'profiles:create',
				input: {
					title: createTitle.trim() || undefined,
					provider: createProvider,
					model: createModel.trim() || undefined,
					apiURL: createApiURL.trim() || undefined,
					config: config && typeof config === 'object' ? config : {},
					options: options && typeof options === 'object' ? options : {},
					apiKey: createApiKey.trim() || undefined,
					makeDefault: createMakeDefault,
				} as any,
			})
			setCreateApiKey('')
			setCreateOpen(false)
			await refresh()
		} catch (e) {
			setError(rpcErrorMessage(e, '无法创建 profile'))
		}
	}

	const openEdit = (p: Profile) => {
		setEditId(p.id)
		setEditTitle(p.title ?? '')
		setEditProvider(p.provider ?? '')
		setEditModel(p.model ?? '')
		setEditApiURL(p.apiURL ?? '')
		setEditEnabled(!!p.enabled)
		setEditConfigJson(JSON.stringify(p.config ?? {}, null, 2))
		setEditOptionsJson(JSON.stringify(p.options ?? {}, null, 2))
		setEditOpen(true)
	}

	const saveEdit = async () => {
		if (!editId) return
		try {
			const config = editConfigJson.trim() ? JSON.parse(editConfigJson) : {}
			const options = editOptionsJson.trim() ? JSON.parse(editOptionsJson) : {}

			await ui.request({
				type: 'profiles:update',
				id: editId,
				input: {
					enabled: editEnabled,
					title: editTitle.trim() || undefined,
					provider: editProvider,
					model: editModel.trim() || undefined,
					apiURL: editApiURL.trim() || undefined,
					config: config && typeof config === 'object' ? config : {},
					options: options && typeof options === 'object' ? options : {},
				} as any,
			})

			setEditOpen(false)
			await refresh()
		} catch (e) {
			setError(rpcErrorMessage(e, '无法更新 profile'))
		}
	}

	return (
		<Stack gap="md">
			<Group justify="space-between" align="center">
				<Group gap="xs">
					<Title order={4}>Ax Profiles</Title>
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

			{profiles.map((p) => (
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
							</Group>
							<Text size="sm" c="dimmed">
								provider: <Code>{p.provider}</Code> {p.model ? <>model: <Code>{p.model}</Code></> : null}{' '}
								{p.apiURL ? <>apiURL: <Code>{p.apiURL}</Code></> : null}
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
								onClick={() =>
									ui
										.request({ type: 'profiles:update', id: p.id, input: { enabled: !p.enabled } as any })
										.then(() => refresh())
										.catch((e: unknown) => setError(rpcErrorMessage(e, '无法更新 enabled')))
								}
							>
								{p.enabled ? <IconToggleRight size={16} /> : <IconToggleLeft size={16} />}
							</ActionIcon>
							<ActionIcon
								variant="light"
								aria-label="设为默认"
								onClick={() =>
									ui
										.request({ type: 'profiles:setDefault', id: p.id })
										.then(() => refresh())
										.catch((e: unknown) => setError(rpcErrorMessage(e, '无法设为默认')))
								}
							>
								<IconStar size={16} />
							</ActionIcon>
							<ActionIcon
								variant="light"
								aria-label="设置 API key"
								onClick={() => {
									const next = window.prompt('API key（将安全写入 Vault）', '')
									if (!next) return
									ui
										.request({ type: 'profiles:setApiKey', id: p.id, apiKey: next })
										.then(() => refresh())
										.catch((e: unknown) => setError(rpcErrorMessage(e, '无法设置 API key')))
								}}
							>
								<IconKey size={16} />
							</ActionIcon>
							<ActionIcon
								variant="light"
								aria-label="清除 API key"
								onClick={() =>
									ui
										.request({ type: 'profiles:clearApiKey', id: p.id })
										.then(() => refresh())
										.catch((e: unknown) => setError(rpcErrorMessage(e, '无法清除 API key')))
								}
							>
								<IconKeyOff size={16} />
							</ActionIcon>
							<ActionIcon
								variant="light"
								color="red"
								aria-label="删除"
								onClick={() => {
									const ok = window.confirm(`Delete profile "${p.title ?? p.provider}"?`)
									if (!ok) return
									ui
										.request({ type: 'profiles:delete', id: p.id })
										.then(() => refresh())
										.catch((e: unknown) => setError(rpcErrorMessage(e, '无法删除 profile')))
								}}
							>
								<IconTrash size={16} />
							</ActionIcon>
						</Group>
					</Group>
				</Card>
			))}

			<Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Create Ax Profile">
				<Stack gap="sm">
					<TextInput label="Title (optional)" value={createTitle} onChange={(e) => setCreateTitle(e.currentTarget.value)} />
					<TextInput label="Provider" value={createProvider} onChange={(e) => setCreateProvider(e.currentTarget.value)} />
					<TextInput label="Model" value={createModel} onChange={(e) => setCreateModel(e.currentTarget.value)} />
					<TextInput
						label="apiURL (optional)"
						value={createApiURL}
						onChange={(e) => setCreateApiURL(e.currentTarget.value)}
						placeholder="https://api.openai.com/v1"
					/>
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

			<Modal opened={editOpen} onClose={() => setEditOpen(false)} title="Edit Ax Profile">
				<Stack gap="sm">
					<TextInput label="Title (optional)" value={editTitle} onChange={(e) => setEditTitle(e.currentTarget.value)} />
					<TextInput label="Provider" value={editProvider} onChange={(e) => setEditProvider(e.currentTarget.value)} />
					<TextInput label="Model" value={editModel} onChange={(e) => setEditModel(e.currentTarget.value)} />
					<TextInput
						label="apiURL (optional)"
						value={editApiURL}
						onChange={(e) => setEditApiURL(e.currentTarget.value)}
						placeholder="https://api.openai.com/v1"
					/>
					<Switch label="Enabled" checked={editEnabled} onChange={(e) => setEditEnabled(e.currentTarget.checked)} />
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
			id: 'ax-profiles',
			priority: 50,
			meta: { label: 'Ax' },
			requireRunning: true,
			render: () => <AxProfilesPanel />,
		},
	],
	setup({ pluginName }) {
		console.log(`[${pluginName}] Ax UI loaded`)
	},
})
