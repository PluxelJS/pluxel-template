import { Badge, Box, Code, Divider, Drawer, Group, ScrollArea, Stack, Table, Text, Title } from '@mantine/core'
import type { UniverPluginSpec } from '@pluxel/univer-protocol'
import { useMemo } from 'react'

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
	const installed = useMemo(() => [...(rt?.installedPlugins ?? new Set())].sort((a, b) => a.localeCompare(b)), [rt])

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
		<Drawer
			opened={props.opened}
			onClose={props.onClose}
			position="right"
			size={720}
			title="Debug"
			overlayProps={{ opacity: 0.15 }}
		>
			<Stack gap="sm">
				<Group justify="space-between">
					<Stack gap={2}>
						<Title order={5}>Runtime</Title>
						<Text size="sm" c="dimmed">
							ready: <Code>{String(props.ready)}</Code> · workbook: <Code>{props.workbookId || '(none)'}</Code>
						</Text>
					</Stack>
					<Group gap="xs">
						<Badge color={props.services.workbooks ? 'green' : 'gray'}>workbooks</Badge>
						<Badge color={props.services.ai ? 'green' : 'gray'}>ai</Badge>
					</Group>
				</Group>

				<Divider />

				<Box>
					<Text fw={600} mb={6}>
						Installed (runtime)
					</Text>
					{installed.length ? (
						<Group gap="xs">
							{installed.map((k) => (
								<Badge key={k} variant="light">
									{k}
								</Badge>
							))}
						</Group>
					) : (
						<Text size="sm" c="dimmed">
							(no installed plugins)
						</Text>
					)}
				</Box>

				<Divider />

				<Box>
					<Text fw={600} mb={6}>
						Effective (SSE)
					</Text>
					<ScrollArea h={220} type="always">
						<Table striped highlightOnHover withColumnBorders>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>plugin</Table.Th>
									<Table.Th>id</Table.Th>
									<Table.Th>supported</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{effective.map((p) => (
									<Table.Tr key={p.id}>
										<Table.Td>
											<Code>{p.plugin}</Code>
										</Table.Td>
										<Table.Td>
											<Code>{p.id}</Code>
										</Table.Td>
										<Table.Td>{isSupportedUniverPluginKey(p.plugin) ? 'yes' : 'no'}</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					</ScrollArea>
				</Box>

				<Box>
					<Text fw={600} mb={6}>
						Raw (SSE)
					</Text>
					<ScrollArea h={220} type="always">
						<Table striped highlightOnHover withColumnBorders>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>plugin</Table.Th>
									<Table.Th>id</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{raw.map((p) => (
									<Table.Tr key={p.id}>
										<Table.Td>
											<Code>{p.plugin}</Code>
										</Table.Td>
										<Table.Td>
											<Code>{p.id}</Code>
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					</ScrollArea>
				</Box>

				{unsupported.length ? (
					<Box>
						<Text fw={600} mb={6} c="yellow">
							Unsupported plugin keys (ignored by runtime)
						</Text>
						<Code block>{stableJson(unsupported)}</Code>
					</Box>
				) : null}

				<Box>
					<Text fw={600} mb={6}>
						Effective specs (JSON)
					</Text>
					<Code block>{stableJson(effective)}</Code>
				</Box>
			</Stack>
		</Drawer>
	)
}

