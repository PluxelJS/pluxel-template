import type { OtlpViewerRpc } from '../rpc'

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			OtlpViewer: OtlpViewerRpc
		}
	}
}

