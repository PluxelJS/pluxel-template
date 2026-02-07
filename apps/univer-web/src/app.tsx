import { AppShell, Button, Group, Stack, Text, Title } from '@mantine/core'
import {
	ExtensionProvider,
	createGlobalExtensionContext,
	createHmrWebClient,
	createPluginExtensionContext,
} from '@pluxel/hmr/web'
import { useEffect, useMemo, useState } from 'react'

import { DocsTab } from './ui/pages/docs-tab'
import { UniverEditorPage } from './ui/pages/editor-page'
import { parseWorkbookId } from './ui/shared'

function usePathname(): string {
	const [pathname, setPathname] = useState(() => window.location.pathname)
	useEffect(() => {
		const onPop = () => setPathname(window.location.pathname)
		window.addEventListener('popstate', onPop)
		return () => window.removeEventListener('popstate', onPop)
	}, [])
	return pathname
}

export function App() {
	const pathname = usePathname()
	const workbookId = parseWorkbookId(pathname)

	const hmr = useMemo(() => createHmrWebClient(), [])
	useEffect(() => () => hmr.dispose(), [hmr])

	const runningPlugins = useMemo(() => new Set<string>(), [])
	const base = useMemo(() => {
		return createGlobalExtensionContext({
			pathname,
			colorScheme: 'light',
			runningPlugins,
			runningPluginsReady: true,
			services: { hmr },
		})
	}, [hmr, pathname, runningPlugins])

	const ctx = useMemo(() => createPluginExtensionContext(base, { pluginName: 'Univer' }), [base])

	if (workbookId) {
		return (
			<ExtensionProvider value={ctx}>
				<UniverEditorPage ctx={ctx} />
			</ExtensionProvider>
		)
	}

	return (
		<ExtensionProvider value={ctx}>
			<AppShell
				padding="md"
				header={{ height: 56 }}
				styles={{
					main: { height: 'calc(100vh - 56px)' },
				}}
			>
				<AppShell.Header>
					<Group h="100%" px="md" justify="space-between">
						<Group gap="sm">
							<Title order={4}>Pluxel × Univer</Title>
							<Text c="dimmed" size="sm">
								Host: <code>/api</code>
							</Text>
						</Group>
						<Button component="a" href="/" variant="light">
							Home
						</Button>
					</Group>
				</AppShell.Header>
				<AppShell.Main>
					<Stack h="100%" gap="md">
						<DocsTab />
					</Stack>
				</AppShell.Main>
			</AppShell>
		</ExtensionProvider>
	)
}
