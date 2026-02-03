import '@pluxel/hmr/services'
import { describe, expect, it } from 'vitest'
import { withHost } from '@pluxel/test'

import { UniverSheetsHub } from '../src'

describe('pluxel-plugin-univer-sheets', () => {
	it('starts in core runtime (no ext registration) and accepts contributions', async () => {
		await withHost(async (host) => {
			host.add(UniverSheetsHub)
			await host.commit()

			const hub = host.require(UniverSheetsHub)
			const dispose = hub.registerContributionProvider(
				{
					id: 't',
					contribution: () => ({
						type: 'watermark:text',
						id: 'wm',
						settings: { content: 'hello' },
					}),
				},
				{ sourcePlugin: 'tests' },
			)
			expect(typeof dispose).toBe('function')
			dispose()
		})
	})
})
