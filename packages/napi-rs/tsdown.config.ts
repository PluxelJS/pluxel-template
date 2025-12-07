import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: ['./src/index.ts', './src/cli.ts'],
	dts: {
		sourcemap: true,
	},
	format: ['esm'],
	platform: 'node',
	clean: true,
	minify: false,
	treeshake: true,
	external: [],
})
