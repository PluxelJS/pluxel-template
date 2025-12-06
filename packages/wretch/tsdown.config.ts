import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: './src/wretch.ts',
	dts: {
		sourcemap: true,
	},
	format: ['esm'],
	env: {},
	copy: [
		// 'assets/**'
	],
	clean: true,
	minify: true,
	treeshake: true,
	external: [],
})
