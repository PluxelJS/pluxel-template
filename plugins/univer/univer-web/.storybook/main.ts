import type { StorybookConfig } from '@storybook/react-vite'
import path from 'node:path'

const projectRoot = process.cwd()
const repoRoot = path.resolve(projectRoot, '..', '..')
const pluxelRoot = path.resolve(projectRoot, '..', '..', '..', 'pluxel')
const storybookRoot = path.resolve(projectRoot, '.storybook')
const promptkitToon = path.resolve(repoRoot, 'packages/promptkit/src/toon.ts')
const univerProtocol = path.resolve(repoRoot, 'packages/univer-protocol/src/index.ts')

const config: StorybookConfig = {
	stories: ['../src/**/*.stories.@(ts|tsx)'],
	addons: ['@storybook/addon-essentials', '@storybook/addon-interactions', '@storybook/addon-links'],
	framework: {
		name: '@storybook/react-vite',
		options: {},
	},
	docs: {
		autodocs: 'tag',
	},
	viteFinal: async (config) => {
		const allow = new Set([projectRoot, repoRoot, pluxelRoot, storybookRoot, ...(config.server?.fs?.allow ?? [])])
		const existingAlias = config.resolve?.alias ?? []
		const extraAlias = [
			{ find: '@pluxel/promptkit/toon', replacement: promptkitToon },
			{ find: '@pluxel/univer-protocol', replacement: univerProtocol },
		]
		const alias = Array.isArray(existingAlias) ? [...existingAlias, ...extraAlias] : { ...existingAlias, ...Object.fromEntries(extraAlias.map((a) => [a.find, a.replacement])) }
		return {
			...config,
			root: projectRoot,
			resolve: {
				...(config.resolve ?? {}),
				alias,
			},
			server: {
				...(config.server ?? {}),
				fs: {
					...(config.server?.fs ?? {}),
					allow: Array.from(allow),
					deny: [],
				},
			},
		}
	},
}

export default config
