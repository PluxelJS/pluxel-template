import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const backendOrigin = process.env.PLUXEL_HMR_ORIGIN || 'http://localhost:3000'
const promptkitToon = fileURLToPath(new URL('../../packages/promptkit/src/toon.ts', import.meta.url))
const univerProtocol = fileURLToPath(
	new URL('../univer-headless/src/protocol/index.ts', import.meta.url),
)
const semiCss = fileURLToPath(
	new URL('./node_modules/@douyinfe/semi-ui-19/dist/css/semi.css', import.meta.url),
)

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			'@pluxel/promptkit/toon': promptkitToon,
			'@pluxel/univer-headless/protocol': univerProtocol,
			'@douyinfe/semi-ui-19/dist/css/semi.css': semiCss,
		},
	},
	server: {
		// Avoid clashing with the HMR host Vite server.
		port: 5174,
		strictPort: false,
		proxy: {
			'/api': {
				target: backendOrigin,
				changeOrigin: true,
				ws: true,
			},
		},
	},
})
