import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: ['./src/meme-worker.ts', './src/worker.mjs'],
	dts: {
		build: true,
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
