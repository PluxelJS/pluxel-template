import { Alert, Button, Code, Group, Loader, Modal, Paper, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import {
	IconArrowsExchange,
	IconChevronRight,
	IconExternalLink,
	IconFileSpreadsheet,
	IconFolder,
	IconFolderPlus,
	IconPencil,
	IconPlus,
	IconRefresh,
	IconTrash,
	IconWriting,
} from '@tabler/icons-react'
import { rpcErrorMessage, useExtensionContext } from '@pluxel/hmr/web'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { UniverBrowseFolderResult, UniverFolderMeta, UniverWorkbookMeta } from 'pluxel-plugin-univer-workbooks'

import { toEditorUrl } from '../shared'

export function DocsTab() {
	const ctx = useExtensionContext('plugin')
	const rpc = (ctx.services.hmr.ui as any)?.UniverWorkbooks as
		| {
				browseFolder: (folderId: string | null) => Promise<UniverBrowseFolderResult>
				createFolder: (input: { name: string; parentId: string | null }) => Promise<unknown>
				createWorkbook: (input: { name: string; folderId: string | null }) => Promise<unknown>
				renameFolder: (id: string, name: string) => Promise<unknown>
				renameWorkbook: (id: string, name: string) => Promise<unknown>
				deleteWorkbook: (id: string) => Promise<unknown>
				deleteFolder: (id: string, opts?: { recursive?: boolean }) => Promise<unknown>
				listFolders: () => Promise<UniverFolderMeta[]>
				moveWorkbook: (id: string, folderId: string | null) => Promise<unknown>
		  }
		| null

	if (!rpc) {
		return (
			<Alert color="yellow" title="UniverWorkbooks 未启用">
				<Text size="sm">
					当前后端没有提供 <Code>UniverWorkbooks</Code> RPC，无法浏览/创建工作簿。
				</Text>
				<Text size="sm" mt="xs">
					请在 <Code>pluxel.hmr.jsonc</Code> 的 profile 中启用 <Code>pluxel-plugin-univer-workbooks</Code>，然后刷新页面。
				</Text>
			</Alert>
		)
	}

	const [cwdId, setCwdId] = useState<string | null>(null)
	const [browse, setBrowse] = useState<UniverBrowseFolderResult | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const [newWorkbookName, setNewWorkbookName] = useState('New workbook')
	const [newFolderName, setNewFolderName] = useState('New folder')
	const [creatingWorkbook, setCreatingWorkbook] = useState(false)
	const [creatingFolder, setCreatingFolder] = useState(false)

	const [renameOpen, setRenameOpen] = useState(false)
	const [renameKind, setRenameKind] = useState<'folder' | 'workbook'>('workbook')
	const [renameId, setRenameId] = useState<string | null>(null)
	const [renameName, setRenameName] = useState('')
	const [renaming, setRenaming] = useState(false)

	const [moveOpen, setMoveOpen] = useState(false)
	const [moveId, setMoveId] = useState<string | null>(null)
	const [moveTo, setMoveTo] = useState<string | null>(null)
	const [moving, setMoving] = useState(false)
	const [folderIndex, setFolderIndex] = useState<UniverFolderMeta[] | null>(null)

	const refresh = useCallback(
		async (folderId: string | null) => {
			setLoading(true)
			try {
				const data = await rpc.browseFolder(folderId)
				setBrowse(data)
				setError(null)
			} catch (err) {
				setBrowse(null)
				setError(rpcErrorMessage(err, '无法加载文档列表'))
			} finally {
				setLoading(false)
			}
		},
		[rpc],
	)

	useEffect(() => {
		if (!rpc) return
		void refresh(cwdId)
	}, [cwdId, refresh])

	const createFolder = useCallback(async () => {
		const name = newFolderName.trim()
		if (!name) return
		setCreatingFolder(true)
		try {
			await rpc.createFolder({ name, parentId: cwdId })
			setNewFolderName('New folder')
			await refresh(cwdId)
		} catch (err) {
			setError(rpcErrorMessage(err, '创建失败'))
		} finally {
			setCreatingFolder(false)
		}
	}, [cwdId, newFolderName, refresh, rpc])

	const createWorkbook = useCallback(async () => {
		const name = newWorkbookName.trim()
		if (!name) return
		setCreatingWorkbook(true)
		try {
			await rpc.createWorkbook({ name, folderId: cwdId })
			setNewWorkbookName('New workbook')
			await refresh(cwdId)
		} catch (err) {
			setError(rpcErrorMessage(err, '创建失败'))
		} finally {
			setCreatingWorkbook(false)
		}
	}, [cwdId, newWorkbookName, refresh, rpc])

	const openRenameFolder = useCallback((item: UniverFolderMeta) => {
		setRenameKind('folder')
		setRenameId(item.id)
		setRenameName(item.name)
		setRenameOpen(true)
	}, [])

	const openRenameWorkbook = useCallback((item: UniverWorkbookMeta) => {
		setRenameKind('workbook')
		setRenameId(item.id)
		setRenameName(item.name)
		setRenameOpen(true)
	}, [])

	const confirmRename = useCallback(async () => {
		if (!renameId) return
		const name = renameName.trim()
		if (!name) return
		setRenaming(true)
		try {
			if (renameKind === 'folder') {
				await rpc.renameFolder(renameId, name)
			} else {
				await rpc.renameWorkbook(renameId, name)
			}
			setRenameOpen(false)
			setRenameId(null)
			await refresh(cwdId)
		} catch (err) {
			setError(rpcErrorMessage(err, '重命名失败'))
		} finally {
			setRenaming(false)
		}
	}, [cwdId, refresh, renameId, renameKind, renameName, rpc])

	const deleteWorkbook = useCallback(
		async (item: UniverWorkbookMeta) => {
			const ok = ctx.services.ui?.confirm
				? await ctx.services.ui.confirm({
						title: '删除工作簿',
						message: `确定删除「${item.name}」？此操作不可撤销。`,
						tone: 'danger',
					})
				: window.confirm(`确定删除「${item.name}」？此操作不可撤销。`)
			if (!ok) return
			try {
				await rpc.deleteWorkbook(item.id)
				await refresh(cwdId)
			} catch (err) {
				setError(rpcErrorMessage(err, '删除失败'))
			}
		},
		[cwdId, ctx.services.ui, refresh, rpc],
	)

	const deleteFolder = useCallback(
		async (item: UniverFolderMeta) => {
			const ok = ctx.services.ui?.confirm
				? await ctx.services.ui.confirm({
						title: '删除文件夹',
						message: `确定删除「${item.name}」以及其下所有内容？此操作不可撤销。`,
						tone: 'danger',
					})
				: window.confirm(`确定删除「${item.name}」以及其下所有内容？此操作不可撤销。`)
			if (!ok) return
			try {
				await rpc.deleteFolder(item.id, { recursive: true })
				await refresh(cwdId)
			} catch (err) {
				setError(rpcErrorMessage(err, '删除失败'))
			}
		},
		[cwdId, ctx.services.ui, refresh, rpc],
	)

	const openMove = useCallback(
		async (item: UniverWorkbookMeta) => {
			setMoveId(item.id)
			setMoveTo(item.folderId ?? null)
			setMoveOpen(true)
			try {
				const folders = await rpc.listFolders()
				setFolderIndex(folders)
			} catch {
				setFolderIndex(null)
			}
		},
		[rpc],
	)

	const confirmMove = useCallback(async () => {
		if (!moveId) return
		setMoving(true)
		try {
			await rpc.moveWorkbook(moveId, moveTo ?? null)
			setMoveOpen(false)
			setMoveId(null)
			await refresh(cwdId)
		} catch (err) {
			setError(rpcErrorMessage(err, '移动失败'))
		} finally {
			setMoving(false)
		}
	}, [cwdId, moveId, moveTo, refresh, rpc])

	const crumbs = browse?.breadcrumbs ?? []
	const goRoot = useCallback(() => setCwdId(null), [])
	const enterFolder = useCallback((id: string) => setCwdId(id), [])

	const openInPlace = useCallback((id: string) => {
		window.location.href = toEditorUrl(id)
	}, [])
	const openInNewWindow = useCallback((id: string) => {
		window.open(toEditorUrl(id), '_blank', 'noopener,noreferrer')
	}, [])

	const folderOptions = useMemo(() => {
		const folders = folderIndex ?? []
		const byId = new Map(folders.map((f) => [f.id, f]))
		const pathFor = (id: string) => {
			const parts: string[] = []
			let cur: UniverFolderMeta | undefined = byId.get(id)
			const seen = new Set<string>()
			while (cur && !seen.has(cur.id)) {
				seen.add(cur.id)
				parts.push(cur.name)
				cur = cur.parentId ? byId.get(cur.parentId) : undefined
			}
			return parts.reverse().join(' / ')
		}
		const opts = folders.map((f) => ({ id: f.id, label: pathFor(f.id) }))
		opts.sort((a, b) => a.label.localeCompare(b.label))
		return [{ id: '', label: '(Root)' }, ...opts]
	}, [folderIndex])

	return (
		<Stack gap="md" style={{ minHeight: 420 }}>
			<Group justify="space-between" align="flex-end">
				<Stack gap={2}>
					<Title order={4}>Univer 文档</Title>
					<Text size="sm" c="dimmed">
						文件夹 / 工作簿（snapshot@rev）
					</Text>
				</Stack>

				<Group>
					<Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => void refresh(cwdId)} disabled={loading}>
						刷新
					</Button>
				</Group>
			</Group>

			{error ? (
				<Alert color="red" title="错误">
					{error}
				</Alert>
			) : null}

			<Paper withBorder p="md">
				<Stack gap="sm">
					<Group justify="space-between" wrap="wrap" align="flex-end">
						<Stack gap={4}>
							<Group gap="xs" wrap="nowrap">
								<Button variant="subtle" size="sm" onClick={goRoot} styles={{ root: { paddingLeft: 0 } }}>
									Root
								</Button>
								{crumbs.map((c) => (
									<Group key={c.id} gap={4} wrap="nowrap">
										<IconChevronRight size={14} />
										<Button variant="subtle" size="sm" onClick={() => enterFolder(c.id)} styles={{ root: { paddingLeft: 0 } }}>
											{c.name}
										</Button>
									</Group>
								))}
							</Group>
							<Text size="xs" c="dimmed">
								cwd: <Code>{browse?.cwd?.id ?? '(root)'}</Code>
							</Text>
						</Stack>

						<Group gap="sm" wrap="wrap">
							<Group gap="xs">
								<TextInput value={newFolderName} onChange={(e) => setNewFolderName(e.currentTarget.value)} />
								<Button
									leftSection={<IconFolderPlus size={16} />}
									loading={creatingFolder}
									onClick={() => void createFolder()}
								>
									建文件夹
								</Button>
							</Group>
							<Group gap="xs">
								<TextInput value={newWorkbookName} onChange={(e) => setNewWorkbookName(e.currentTarget.value)} />
								<Button leftSection={<IconPlus size={16} />} loading={creatingWorkbook} onClick={() => void createWorkbook()}>
									新建
								</Button>
							</Group>
						</Group>
					</Group>

					{loading ? (
						<Group justify="center" py="md">
							<Loader />
						</Group>
					) : (
						<Table withTableBorder>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>名称</Table.Th>
									<Table.Th>类型</Table.Th>
									<Table.Th>更新时间</Table.Th>
									<Table.Th>操作</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{(browse?.folders ?? []).map((f) => (
									<Table.Tr key={`folder:${f.id}`}>
										<Table.Td>
											<Group gap="xs" wrap="nowrap">
												<IconFolder size={16} />
												<Button
													variant="subtle"
													size="sm"
													onClick={() => enterFolder(f.id)}
													styles={{ root: { paddingLeft: 0 } }}
												>
													{f.name}
												</Button>
											</Group>
										</Table.Td>
										<Table.Td>
											<Text size="sm" c="dimmed">
												folder
											</Text>
										</Table.Td>
										<Table.Td>
											<Text size="sm">{new Date(f.updatedAt).toLocaleString()}</Text>
										</Table.Td>
										<Table.Td>
											<Group gap="xs" wrap="wrap">
												<Button size="xs" variant="light" leftSection={<IconFolder size={14} />} onClick={() => enterFolder(f.id)}>
													打开
												</Button>
												<Button size="xs" variant="subtle" leftSection={<IconPencil size={14} />} onClick={() => openRenameFolder(f)}>
													重命名
												</Button>
												<Button size="xs" color="red" variant="subtle" leftSection={<IconTrash size={14} />} onClick={() => void deleteFolder(f)}>
													删除
												</Button>
											</Group>
										</Table.Td>
									</Table.Tr>
								))}

								{(browse?.workbooks ?? []).map((item) => (
									<Table.Tr key={`workbook:${item.id}`}>
										<Table.Td>
											<Stack gap={2}>
												<Group gap="xs" wrap="nowrap">
													<IconFileSpreadsheet size={16} />
													<Button
														variant="subtle"
														size="sm"
														onClick={() => openInPlace(item.id)}
														styles={{ root: { paddingLeft: 0 } }}
													>
														{item.name}
													</Button>
												</Group>
												<Text size="xs" c="dimmed">
													<Code>{item.id}</Code>
												</Text>
											</Stack>
										</Table.Td>
										<Table.Td>
											<Text size="sm" c="dimmed">
												file · rev <Code>{item.latestRev}</Code>
											</Text>
										</Table.Td>
										<Table.Td>
											<Text size="sm">{new Date(item.updatedAt).toLocaleString()}</Text>
										</Table.Td>
										<Table.Td>
											<Group gap="xs">
												<Button size="xs" variant="light" leftSection={<IconWriting size={14} />} onClick={() => openInPlace(item.id)}>
													打开
												</Button>
												<Button
													size="xs"
													variant="subtle"
													leftSection={<IconExternalLink size={14} />}
													onClick={() => openInNewWindow(item.id)}
												>
													新窗口
												</Button>
												<Button size="xs" variant="subtle" leftSection={<IconPencil size={14} />} onClick={() => openRenameWorkbook(item)}>
													重命名
												</Button>
												<Button size="xs" variant="subtle" leftSection={<IconArrowsExchange size={14} />} onClick={() => void openMove(item)}>
													移动
												</Button>
												<Button size="xs" color="red" variant="subtle" leftSection={<IconTrash size={14} />} onClick={() => void deleteWorkbook(item)}>
													删除
												</Button>
											</Group>
										</Table.Td>
									</Table.Tr>
								))}
								{(browse?.folders?.length ?? 0) + (browse?.workbooks?.length ?? 0) === 0 ? (
									<Table.Tr>
										<Table.Td colSpan={4}>
											<Text size="sm" c="dimmed">
												暂无内容
											</Text>
										</Table.Td>
									</Table.Tr>
								) : null}
							</Table.Tbody>
						</Table>
					)}
				</Stack>
			</Paper>

			<Modal opened={renameOpen} onClose={() => setRenameOpen(false)} title="重命名" centered>
				<Stack>
					<TextInput value={renameName} onChange={(e) => setRenameName(e.currentTarget.value)} />
					<Group justify="flex-end">
						<Button variant="light" onClick={() => setRenameOpen(false)}>
							取消
						</Button>
						<Button loading={renaming} onClick={() => void confirmRename()}>
							保存
						</Button>
					</Group>
				</Stack>
			</Modal>

			<Modal opened={moveOpen} onClose={() => setMoveOpen(false)} title="移动到..." centered>
				<Stack>
					<Text size="sm" c="dimmed">
						选择目标文件夹（Root 表示顶层）。
					</Text>
					<Table withTableBorder>
						<Table.Tbody>
							{folderOptions.map((opt) => (
								<Table.Tr
									key={opt.id}
									style={{
										cursor: 'pointer',
										background: (moveTo ?? '') === opt.id ? 'rgba(0,0,0,0.06)' : undefined,
									}}
									onClick={() => setMoveTo(opt.id || null)}
								>
									<Table.Td>
										<Text size="sm">{opt.label}</Text>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
					<Group justify="flex-end">
						<Button variant="light" onClick={() => setMoveOpen(false)}>
							取消
						</Button>
						<Button loading={moving} onClick={() => void confirmMove()}>
							移动
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	)
}
