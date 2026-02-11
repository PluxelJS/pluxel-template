import type { UniverCapabilitiesSnapshot } from './capabilities'
import type { UniverLoopbackRunInput, UniverLoopbackRunResult } from './loopback'

export type UniverRpc = {
	capabilities(): Promise<UniverCapabilitiesSnapshot>
}

export type UniverLoopbackRpc = {
	runLoopback(input: UniverLoopbackRunInput): Promise<UniverLoopbackRunResult>
}
