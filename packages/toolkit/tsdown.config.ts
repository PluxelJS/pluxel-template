import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		index: './src/index.ts',
		pacer: './src/pacer.ts',
		cache: './src/cache.ts',
		hash: './src/hash.ts',
		ohash: './src/ohash.ts',
		id: './src/id.ts',
		option: './src/option/index.ts',
		time: './src/time.ts',
	},
	dts: {
		sourcemap: true,
		resolve: [
			'@tanstack/pacer',
			'@neophi/sieve-cache',
			'lru-cache',
			'option-t',
			'nanoid',
			'ohash',
			'rapidhash-js',
		],
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
