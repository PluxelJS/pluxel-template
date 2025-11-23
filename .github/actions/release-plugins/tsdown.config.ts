import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: true,
	entry: 'index.ts',
	outDir: '.',
 	dts: false,
	format: ['esm'],
	env: {},
	// Don't use copy for files in the same directory
	// The config files will be bundled or read at runtime
	copy: [],
	clean: false,
	minify: true,
	treeshake: true,
	external: [],
})
