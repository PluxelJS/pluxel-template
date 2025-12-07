import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: './src/leafui.ts',
	dts: {
		build: true,
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
	// 供 pluxel-cli build 覆盖
	external: [],
})
