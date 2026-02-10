import '../node_modules/@douyinfe/semi-ui-19/dist/css/semi.css'
import '../src/ui/univer/bootstrap'
import '../src/ui/styles.css'

import type { Preview } from '@storybook/react'

const preview: Preview = {
	parameters: {
		layout: 'fullscreen',
		actions: { argTypesRegex: '^on[A-Z].*' },
	},
}

export default preview
