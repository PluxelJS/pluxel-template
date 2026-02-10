import type { UniverLoopbackRunInput, UniverLoopbackRunResult } from '@pluxel/univer-protocol'

export type LoopbackBackend = {
	runLoopback(input: UniverLoopbackRunInput): Promise<UniverLoopbackRunResult>
}

