import '@mantine/core/styles.css'

import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/sheets-ui/lib/index.css'

import '@univerjs/sheets/facade'
import '@univerjs/sheets-ui/facade'
import '@univerjs/watermark/facade'

import './ui/styles.css'

import { MantineProvider } from '@mantine/core'
import React from 'react'
import ReactDOM from 'react-dom/client'

import { App } from './app'

ReactDOM.createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<MantineProvider defaultColorScheme="light">
			<App />
		</MantineProvider>
	</React.StrictMode>,
)
