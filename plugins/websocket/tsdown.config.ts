import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: './src/websocket.ts',
	dts: {
		sourcemap: true,
	},
	format: ['esm'],
	env: {},
	copy: [],
	clean: true,
	minify: true,
	treeshake: true,
	external: [],
})
