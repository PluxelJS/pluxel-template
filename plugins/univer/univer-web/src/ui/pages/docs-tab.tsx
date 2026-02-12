import {
	Banner,
	Breadcrumb,
	Button,
	Card,
	Empty,
	Input,
	Select,
	Space,
	Table,
	Tag,
	Typography,
} from '@douyinfe/semi-ui-19'
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

import { AppModal, CodeInline, Muted, PageTitle } from '../kit'
import { toEditorUrl } from '../shared'

type DocRow = {
	key: string
	kind: 'folder' | 'workbook'
	id: string
	name: string
	updatedAt: number
	latestRev?: number
	folderId?: string | null
}

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
			if (!rpc) {
				setBrowse(null)
				setLoading(false)
				setError('UniverWorkbooks RPC 未启用')
				return
			}
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
		if (!rpc) return
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
		if (!rpc) return
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
		if (!rpc) return
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
			if (!rpc) return
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
			if (!rpc) return
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
			if (!rpc) return
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
		if (!rpc) return
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
		const opts = folders.map((f) => ({ value: f.id, label: pathFor(f.id) }))
		opts.sort((a, b) => a.label.localeCompare(b.label))
		return [{ value: '', label: '(Root)' }, ...opts]
	}, [folderIndex])

	const rows: DocRow[] = useMemo(() => {
		const list: DocRow[] = []
		for (const f of browse?.folders ?? []) {
			list.push({
				key: `folder:${f.id}`,
				kind: 'folder',
				id: f.id,
				name: f.name,
				updatedAt: f.updatedAt,
			})
		}
		for (const w of browse?.workbooks ?? []) {
			list.push({
				key: `workbook:${w.id}`,
				kind: 'workbook',
				id: w.id,
				name: w.name,
				updatedAt: w.updatedAt,
				latestRev: w.latestRev,
				folderId: w.folderId ?? null,
			})
		}
		return list
		}, [browse])

	if (!rpc) {
		return (
			<Banner
				fullMode={false}
				type="warning"
				description={
					<Space vertical align="start" spacing="tight">
						<div>
							当前后端没有提供 <CodeInline>UniverWorkbooks</CodeInline> RPC，无法浏览/创建工作簿。
						</div>
						<div>
							请在 <CodeInline>pluxel.hmr.jsonc</CodeInline> 的 profile 中启用{' '}
							<CodeInline>pluxel-plugin-univer-workbooks</CodeInline>，然后刷新页面。
						</div>
					</Space>
				}
				title="UniverWorkbooks 未启用"
			/>
		)
	}

	return (
		<div className="univer-docs">
			<div className="univer-header-row">
				<div>
					<PageTitle>Univer 文档</PageTitle>
					<Muted>文件夹 / 工作簿（snapshot@rev）</Muted>
				</div>
				<Button
					theme="borderless"
					icon={<IconRefresh size={16} />}
					disabled={loading}
					onClick={() => void refresh(cwdId)}
				>
					刷新
				</Button>
			</div>

			{error ? <Banner fullMode={false} type="danger" description={error} title="错误" /> : null}

			<Card className="univer-card" bodyStyle={{ padding: 20 }}>
				<Space vertical align="start" spacing="loose" style={{ width: '100%' }}>
					<Space vertical align="start" spacing="tight" style={{ width: '100%' }}>
						<Breadcrumb
							routes={[]}
							separator={<IconChevronRight size={14} />}
							style={{ marginBottom: 4 }}
						>
							<Breadcrumb.Item onClick={goRoot}>Root</Breadcrumb.Item>
							{crumbs.map((c) => (
								<Breadcrumb.Item key={c.id} onClick={() => enterFolder(c.id)}>
									{c.name}
								</Breadcrumb.Item>
							))}
						</Breadcrumb>
						<Typography.Text type="tertiary">
							cwd: <CodeInline>{browse?.cwd?.id ?? '(root)'}</CodeInline>
						</Typography.Text>
					</Space>

					<div className="univer-action-row">
						<div className="univer-input-row">
							<Input
								value={newFolderName}
								onChange={(value: string) => setNewFolderName(value)}
								placeholder="Folder name"
								style={{ width: 180 }}
							/>
							<Button
								type="secondary"
								icon={<IconFolderPlus size={16} />}
								disabled={creatingFolder}
								onClick={() => void createFolder()}
							>
								建文件夹
							</Button>
						</div>

						<div className="univer-input-row">
							<Input
								value={newWorkbookName}
								onChange={(value: string) => setNewWorkbookName(value)}
								placeholder="Workbook name"
								style={{ width: 180 }}
							/>
							<Button
								type="primary"
								icon={<IconPlus size={16} />}
								disabled={creatingWorkbook}
								onClick={() => void createWorkbook()}
							>
								新建
							</Button>
						</div>
					</div>

					<Table
						dataSource={rows}
						rowKey="key"
						pagination={false}
						loading={loading}
						empty={<Empty description="暂无内容" />}
						columns={[
							{
								title: '名称',
								dataIndex: 'name',
								render: (_text: string, record: DocRow) => {
									if (record.kind === 'folder') {
										return (
											<Space align="center">
												<IconFolder size={16} />
												<Button
													theme="borderless"
													onClick={() => enterFolder(record.id)}
												>
													{record.name}
												</Button>
											</Space>
										)
									}
									return (
										<Space vertical align="start" spacing="tight">
											<Space align="center">
												<IconFileSpreadsheet size={16} />
												<Button
													theme="borderless"
													onClick={() => openInPlace(record.id)}
												>
													{record.name}
												</Button>
											</Space>
											<Typography.Text type="tertiary">
												<CodeInline>{record.id}</CodeInline>
											</Typography.Text>
										</Space>
									)
								},
							},
							{
								title: '类型',
								dataIndex: 'kind',
								render: (_text: string, record: DocRow) => (
									<Tag color={record.kind === 'folder' ? 'cyan' : 'violet'}>
										{record.kind === 'folder'
											? 'folder'
											: `file · rev ${record.latestRev ?? ''}`}
									</Tag>
								),
							},
							{
								title: '更新时间',
								dataIndex: 'updatedAt',
								render: (val: number) => new Date(val).toLocaleString(),
							},
							{
								title: '操作',
								dataIndex: 'actions',
								render: (_text: string, record: DocRow) => {
									if (record.kind === 'folder') {
										return (
											<Space wrap>
												<Button
													size="small"
													icon={<IconFolder size={14} />}
													onClick={() => enterFolder(record.id)}
												>
													打开
												</Button>
												<Button
													size="small"
													theme="borderless"
													icon={<IconPencil size={14} />}
													onClick={() => openRenameFolder({ id: record.id, name: record.name } as UniverFolderMeta)}
												>
													重命名
												</Button>
												<Button
													size="small"
													theme="borderless"
													type="danger"
													icon={<IconTrash size={14} />}
													onClick={() => void deleteFolder({ id: record.id, name: record.name } as UniverFolderMeta)}
												>
													删除
												</Button>
											</Space>
										)
									}

									return (
										<Space wrap>
											<Button
												size="small"
												icon={<IconWriting size={14} />}
												onClick={() => openInPlace(record.id)}
											>
												打开
											</Button>
											<Button
												size="small"
												theme="borderless"
												icon={<IconExternalLink size={14} />}
												onClick={() => openInNewWindow(record.id)}
											>
												新窗口
											</Button>
											<Button
												size="small"
												theme="borderless"
												icon={<IconPencil size={14} />}
												onClick={() =>
													openRenameWorkbook({ id: record.id, name: record.name } as UniverWorkbookMeta)
												}
											>
												重命名
											</Button>
											<Button
												size="small"
												theme="borderless"
												icon={<IconArrowsExchange size={14} />}
												onClick={() => void openMove({
													id: record.id,
													folderId: record.folderId ?? null,
												} as UniverWorkbookMeta)}
											>
												移动
											</Button>
											<Button
												size="small"
												theme="borderless"
												type="danger"
												icon={<IconTrash size={14} />}
												onClick={() =>
													void deleteWorkbook({ id: record.id, name: record.name } as UniverWorkbookMeta)
												}
											>
												删除
											</Button>
										</Space>
									)
								},
							},
						]}
					/>
				</Space>
			</Card>

			<AppModal
				open={renameOpen}
				onOpenChange={setRenameOpen}
				title="重命名"
				footer={
					<Space>
						<Button theme="borderless" onClick={() => setRenameOpen(false)}>
							取消
						</Button>
						<Button type="primary" loading={renaming} onClick={() => void confirmRename()}>
							保存
						</Button>
					</Space>
				}
			>
				<Input value={renameName} onChange={(value: string) => setRenameName(value)} />
			</AppModal>

			<AppModal
				open={moveOpen}
				onOpenChange={setMoveOpen}
				title="移动到..."
				size="lg"
				footer={
					<Space>
						<Button theme="borderless" onClick={() => setMoveOpen(false)}>
							取消
						</Button>
						<Button type="primary" loading={moving} onClick={() => void confirmMove()}>
							移动
						</Button>
					</Space>
				}
			>
				<Space vertical align="start" spacing="tight" style={{ width: '100%' }}>
					<Muted>选择目标文件夹（Root 表示顶层）。</Muted>
				<Select
					value={moveTo ?? ''}
					onChange={(value: unknown) => setMoveTo(value ? String(value) : null)}
						optionList={folderOptions}
						style={{ width: '100%' }}
						placeholder="选择目标文件夹"
						filter
					/>
				</Space>
			</AppModal>
		</div>
	)
}
