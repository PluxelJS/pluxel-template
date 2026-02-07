import type { FontManagerRpc } from '../rpc'
import type { FontSnapshot } from '../font-manager'

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			FontManager: FontManagerRpc
		}

		interface sse {
			FontManager: { type: 'sync'; snapshot: FontSnapshot }
		}
	}
}
