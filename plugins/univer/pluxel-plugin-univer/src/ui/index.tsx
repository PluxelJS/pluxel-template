import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/sheets-ui/lib/index.css'

import './styles.css'

import { definePluginUIModule, ExtensionPoints } from '@pluxel/hmr/web'

import '@univerjs/sheets/facade'
import '@univerjs/sheets-ui/facade'
import '@univerjs/watermark/facade'

import { DocsTab } from './pages/docs-tab'
import { UniverEditorPage } from './pages/editor-page'

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.PluginTabs,
			id: 'univer-docs',
			priority: 50,
			meta: { label: 'Univer' },
			requireRunning: true,
			render: () => <DocsTab />,
		},
	],
	routes: [
		{
			definition: {
				path: '/univer/workbooks/:id',
				title: 'Univer Editor',
				addToNav: false,
				frame: 'standalone',
			},
			render: (ctx) => <UniverEditorPage ctx={ctx} />,
		},
	],
	setup({ pluginName }) {
		console.log(`[${pluginName}] Univer UI loaded`)
	},
})

