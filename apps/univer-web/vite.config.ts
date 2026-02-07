import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const backendOrigin = process.env.PLUXEL_HMR_ORIGIN || 'http://localhost:3000'
const promptkitToon = fileURLToPath(new URL('../../packages/promptkit/src/toon.ts', import.meta.url))
const univerProtocol = fileURLToPath(
	new URL('../../packages/univer-protocol/src/index.ts', import.meta.url),
)

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			'@pluxel/promptkit/toon': promptkitToon,
			'@pluxel/univer-protocol': univerProtocol,
		},
	},
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			'/api': {
				target: backendOrigin,
				changeOrigin: true,
				ws: true,
			},
		},
	},
})
