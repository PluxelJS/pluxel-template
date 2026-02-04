import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		index: './src/index.ts',
		toon: './src/toon.ts',
		mdream: './src/mdream/index.ts',
		'mdream-plugins': './src/mdream/plugins.ts',
		'mdream-preset-minimal': './src/mdream/preset/minimal.ts',
	},
	dts: {
		sourcemap: true,
		resolve: ['@toon-format/toon', 'mdream'],
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
