import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		index: './src/index.ts',
		decorators: './src/decorators.ts',
	},
	dts: {
		sourcemap: true,
	},
	format: ['esm'],
	env: {},
	copy: [],
	clean: true,
	minify: true,
	treeshake: true,
	// 供 pluxel-cli build 覆盖
	external: [],
})

