import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: ['./src/canvas-worker.ts', './src/worker.ts'],
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
