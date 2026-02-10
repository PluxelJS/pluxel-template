import type { UniverLoopbackRunInput, UniverLoopbackRunResult } from '@pluxel/univer-headless/protocol'

export type LoopbackBackend = {
	runLoopback(input: UniverLoopbackRunInput): Promise<UniverLoopbackRunResult>
}
