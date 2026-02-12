import { agent, type AxFunction, type AxProgrammable, type AxStepHooks } from '@ax-llm/ax'
import { context as otelContext, trace } from '@opentelemetry/api'
import type { Tracer } from '@opentelemetry/api'

import { UNIVER_LOOPBACK_QA_DEFINITION } from './prompt'

export type UniverLoopbackEditorProgram = ReturnType<typeof createUniverLoopbackEditorProgram>
export type UniverLoopbackQualityProgram = ReturnType<typeof createUniverLoopbackQualityProgram>

export type UniverLoopbackEditorIn = Readonly<{
	instruction: string
	readScopes: string[]
	writeScopes: string[]
	current: string
	feedback?: string
}>

export type UniverLoopbackEditorOut = Readonly<{
	done: boolean
	summary: string
}>

export type UniverLoopbackQualityIn = Readonly<{
	instruction: string
	summary: string
	readScopes: string[]
	writeScopes: string[]
	current: string
	wrote: boolean
	verifiedAfterWrite: boolean
	hadErrors: boolean
}>

export type UniverLoopbackQualityOut = Readonly<{
	ok: boolean
	confidence: number
	feedback: string
}>

export function createUniverLoopbackStepHooks(tracer?: Tracer): AxStepHooks | undefined {
	if (!tracer) return undefined
	return {
		afterFunctionExecution: (ctx) => {
			const span = trace.getSpan(otelContext.active())
			if (!span) return
			const last = ctx.lastFunctionCalls.slice(-6)
			span.addEvent('ax.functions', {
				'ax.step.index': ctx.stepIndex,
				'ax.step.max': ctx.maxSteps,
				'ax.functions.count': last.length,
				'ax.functions.names': last.map((c) => c.name).join(','),
				'ax.usage.total_tokens': ctx.usage.totalTokens,
			})
		},
	}
}

export function createUniverLoopbackEditorProgram(input: { definition: string; tools: AxFunction[] }) {
	return agent(
		'instruction:string, readScopes:string[], writeScopes:string[], current:string, feedback?:string -> done:boolean, summary:string',
		{
			name: 'univerLoopbackEditor',
			description: 'Edits a Univer spreadsheet via tools and verifies results.',
			definition: input.definition,
			functions: input.tools,
		},
	) as AxProgrammable<UniverLoopbackEditorIn, UniverLoopbackEditorOut>
}

export function createUniverLoopbackQualityProgram(input: { tools: AxFunction[] }) {
	return agent(
		'instruction:string, summary:string, readScopes:string[], writeScopes:string[], current:string, wrote:boolean, verifiedAfterWrite:boolean, hadErrors:boolean -> ok:boolean, confidence:number, feedback:string',
		{
			name: 'univerLoopbackQualityCheck',
			description: 'Strict QA evaluator for Univer edits (read-only spot checks).',
			definition: UNIVER_LOOPBACK_QA_DEFINITION,
			functions: input.tools,
		},
	) as AxProgrammable<UniverLoopbackQualityIn, UniverLoopbackQualityOut>
}
