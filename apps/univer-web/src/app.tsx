import { Button, Layout, Space, Tag, Typography } from '@douyinfe/semi-ui-19'
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
			<Layout className="univer-shell">
				<Layout.Header className="univer-topbar">
					<div className="univer-topbar__inner">
						<Space align="center" spacing="tight">
							<Typography.Text strong>Pluxel × Univer</Typography.Text>
							<Tag color="blue" size="small">
								Host: /api
							</Tag>
						</Space>
						<Button
							theme="borderless"
							type="primary"
							onClick={() => {
								window.location.href = '/'
							}}
						>
							Home
						</Button>
					</div>
				</Layout.Header>
				<Layout.Content className="univer-content">
					<DocsTab />
				</Layout.Content>
			</Layout>
		</ExtensionProvider>
	)
}
