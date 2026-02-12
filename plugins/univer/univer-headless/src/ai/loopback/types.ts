import type { UniverAiContext } from '../../protocol'
import type { McpStats } from '../mcp/context'

export type UniverAxLoopbackInput = Readonly<{
	instruction: string
	scopes: Readonly<{
		read: readonly string[]
		write?: readonly string[]
		current?: string
	}>
	contexts?: Readonly<{ selections: readonly UniverAiContext[] }>
}>

export type UniverAxLoopbackStats = Readonly<McpStats>

export type UniverAxLoopbackResult = Readonly<
	| { ok: true; summary: string; stats: UniverAxLoopbackStats; rounds: number }
	| { ok: false; error: string; stats: UniverAxLoopbackStats; rounds: number }
>
