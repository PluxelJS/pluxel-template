import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		index: './src/mikro-orm.ts',
		'mikro-orm/core': './src/reexport/core.ts',
		'mikro-orm/knex': './src/reexport/knex.ts',
		'mikro-orm/libsql': './src/reexport/libsql.ts',
		'libsql/client': './src/reexport/libsql-client.ts',
	},
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
