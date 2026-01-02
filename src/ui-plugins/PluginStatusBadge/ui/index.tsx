import { ActionIcon, Badge, Group, Text } from '@mantine/core'
import { definePluginUIModule, ExtensionPoints, rpcErrorMessage, useExtensionContext } from '@pluxel/hmr/web'
import { IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'

function StatusBadge() {
	const ctx = useExtensionContext('plugin')
	const rpc = ctx.services.hmr.rpc.PluginStatusBadge
	const sse = ctx.services.hmr.sse

	const [counter, setCounter] = useState<number | null>(null)
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		try {
			const res = await rpc.counter()
			setCounter(res.counter)
			setError(null)
		} catch (e) {
			setError(rpcErrorMessage(e, '无法读取计数器'))
		}
	}, [rpc])

	useEffect(() => {
		void refresh()
	}, [refresh])

	useEffect(() => {
		const off = sse.PluginStatusBadge.on(
			(msg) => {
				const payload = msg.payload
				if (payload.type === 'ready' || payload.type === 'counter') {
					setCounter(payload.counter)
					setError(null)
				}
			},
			['ready', 'counter'],
		)
		return () => off()
	}, [sse])

	return (
		<Group gap="xs">
			<Badge variant="light" color="blue">
				counter: {counter ?? '—'}
			</Badge>
			<ActionIcon variant="subtle" aria-label="刷新计数器" onClick={() => void refresh()}>
				<IconRefresh size={16} />
			</ActionIcon>
			{error ? (
				<Text size="xs" c="red">
					{error}
				</Text>
			) : null}
		</Group>
	)
}

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.PluginInfo,
			id: 'status-badge',
			priority: 50,
			requireRunning: true,
			Component: StatusBadge,
		},
	],
})

