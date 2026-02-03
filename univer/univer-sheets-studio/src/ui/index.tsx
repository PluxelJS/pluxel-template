import { Center, Loader } from '@mantine/core'
import { definePluginUIModule } from '@pluxel/hmr/web'
import { useExtensionContext } from '@pluxel/hmr/web'
import { IconSparkles } from '@tabler/icons-react'
import { Suspense, lazy, useEffect } from 'react'

const StudioRoute = lazy(() => import('./StudioRoute'))

function Route() {
	const { pluginName } = useExtensionContext('plugin')

	useEffect(() => {
		if (typeof window === 'undefined') return
		const p = window.location.pathname
		const shellPrefix = `/ext/${encodeURIComponent(pluginName)}`
		const standalonePrefix = `/ext-standalone/${encodeURIComponent(pluginName)}`
		if (p.startsWith(shellPrefix) && !p.startsWith(standalonePrefix)) {
			const next =
				standalonePrefix + p.slice(shellPrefix.length) + window.location.search + window.location.hash
			window.location.replace(next)
		}
	}, [pluginName])

	return (
		<Suspense
			fallback={
				<Center style={{ height: 360 }}>
					<Loader size="sm" />
				</Center>
			}
		>
			<StudioRoute />
		</Suspense>
	)
}

export default definePluginUIModule({
	routes: [
		{
			definition: {
				path: '/sheets-studio',
				title: 'Sheets Studio',
				icon: <IconSparkles size={18} stroke={1.7} />,
				addToNav: true,
				navPriority: 29,
				frame: 'standalone',
			},
			render: () => <Route />,
		},
	],
})

