import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		index: './src/index.ts',
	},
	dts: {
		sourcemap: true,
	},
	format: ['esm'],
	clean: true,
	minify: true,
	treeshake: true,
	external: [],
})

