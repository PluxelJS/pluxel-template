import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: ['./src/meme-worker.ts', './src/worker.ts', './src/preview-runner.mjs'],
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
