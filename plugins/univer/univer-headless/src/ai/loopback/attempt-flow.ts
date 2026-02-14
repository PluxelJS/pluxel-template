import { AxFlow, flow, type AxAI, type AxProgrammable, type AxStepHooks } from '@ax-llm/ax'
import { context as otelContext, trace } from '@opentelemetry/api'
import type { Tracer } from '@opentelemetry/api'

import type { McpStats } from '../mcp/context'
import type { UniverAxOtelInstruments } from './otel'
import { clampInt } from './limits'
import { evaluateUniverAxAttempt } from './attempt-eval'
import { UNIVER_LOOPBACK_QA_CONFIDENCE_THRESHOLD } from './policy'
import type { UniverLoopbackEditorIn, UniverLoopbackEditorOut, UniverLoopbackQualityIn, UniverLoopbackQualityOut } from './programs'

// AxFlow's ctor currently prints a deprecation warning even when using the `flow()` factory.
// Silence it to keep loopback output clean; behavior is unchanged.
try {
	;(AxFlow as any)._ctorWarned = true
} catch {
	// best-effort
}

export type AttemptFlowIn = Readonly<{
	instruction: string
	readScopes: string[]
	writeScopes: string[]
	current: string
}>

export type AttemptFlowOut = Readonly<{
	done: boolean
	summary: string
	attempts: number
}>

export type AttemptEditorResult = UniverLoopbackEditorOut
export type AttemptQualityResult = UniverLoopbackQualityOut

type AttemptSeedState = AttemptFlowIn & Readonly<{ attempt: number; feedback: string }>
type AttemptStartState = AttemptSeedState &
	Readonly<{ attemptStartSeq: number; attemptStartToolCalls: number; attemptStartErrors: number }>

type AttemptState = AttemptStartState &
	Readonly<{
		editResult: AttemptEditorResult
		done: boolean
		evaluation: ReturnType<typeof evaluateUniverAxAttempt>
		quality?: Readonly<{ ok: boolean; confidence: number; feedback: string }>
	}>

type QualityAssert = Readonly<{
	fn: (values: AttemptQualityResult) => boolean | string | undefined | Promise<boolean | string | undefined>
	message?: string
}>

const QUALITY_ASSERTS: QualityAssert[] = [
	{
		fn: (values: AttemptQualityResult) => {
			const confidence = values.confidence
			if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return 'confidence must be a number between 0 and 1'
			const ok = values.ok
			const feedback = values.feedback.trim()
			if (!ok && !feedback) return 'feedback must be non-empty when ok=false'
			return true
		},
	},
]

export async function runUniverLoopbackAttemptFlow(
	ai: AxAI,
	input: AttemptFlowIn,
	opts: Readonly<{
		maxAttempts: number
		maxStepsPerAttempt: number
		editor: AxProgrammable<UniverLoopbackEditorIn, UniverLoopbackEditorOut>
		qualityCheck?: AxProgrammable<UniverLoopbackQualityIn, UniverLoopbackQualityOut>
		qualityCheckMode?: 'off' | 'auto' | 'always'
		stats: McpStats
		stepHooks?: AxStepHooks
		tracer?: Tracer
	instruments?: UniverAxOtelInstruments
	}>,
): Promise<AttemptFlowOut> {
	const loop = flow<AttemptFlowIn, AttemptFlowOut>()
		.node('edit', opts.editor)
		.map((s): AttemptSeedState => ({ ...s, attempt: 0, feedback: '' }))
		.label('attempt')
		.map((s): AttemptStartState => ({
			...s,
			attemptStartSeq: opts.stats.callSeq ?? 0,
			attemptStartToolCalls: opts.stats.toolCalls,
			attemptStartErrors: opts.stats.toolErrors ?? 0,
		}))
		.execute(
			'edit',
			(s): UniverLoopbackEditorIn => ({
				instruction: String(s.instruction ?? '').trim(),
				readScopes: s.readScopes,
				writeScopes: s.writeScopes,
				current: s.current,
				...(s.feedback ? { feedback: s.feedback } : {}),
			}),
			{ options: { maxSteps: opts.maxStepsPerAttempt, stepHooks: opts.stepHooks, traceLabel: 'univer/loopback:edit' } },
		)
		.map(async (s): Promise<AttemptState> => {
			const editResult = s.editResult
			const lastWriteSeq = opts.stats.lastWriteSeq ?? 0
			const lastReadSeq = opts.stats.lastReadSeq ?? 0
			const lastVerifySeq = opts.stats.lastVerifySeq ?? 0
			const lastErrorSeq = opts.stats.lastErrorSeq ?? 0

			const errorsDelta = (opts.stats.toolErrors ?? 0) - s.attemptStartErrors
			const toolCallsDelta = opts.stats.toolCalls - s.attemptStartToolCalls

			const evaluation = evaluateUniverAxAttempt({
				attemptStartSeq: s.attemptStartSeq,
				lastWriteSeq,
				lastReadSeq,
				lastVerifySeq,
				lastErrorSeq,
				modelDone: Boolean(editResult.done),
			})

			let done = evaluation.done
			let feedback = evaluation.feedback
			let quality: AttemptState['quality'] = undefined

			// Make the next attempt more "budget aware": users often hit the step budget because the model
			// spreads work across too many small tool calls. The only chance to course-correct is before
			// the final attempt starts.
			const attemptNumber = s.attempt + 1
			const remainingAfterThisAttempt = Math.max(0, opts.maxAttempts - attemptNumber)
			if (!done && remainingAfterThisAttempt === 1) {
				feedback = [
					feedback || 'Not done yet.',
					'Next attempt is the FINAL attempt. You MUST minimize tool calls: use batch tools (get_ranges_data/set_ranges_data), avoid scanning, apply the smallest necessary edits, and verify with targeted reads (or write-tool readback).',
				]
					.filter(Boolean)
					.join('\n')
			}
			if (!done && !evaluation.wrote && toolCallsDelta >= 12) {
				feedback = [
					feedback || 'Not done yet.',
					'You are spending too many tool calls without applying writes. Stop scanning; use search_cells to narrow, or ask the user to reduce read scope / pin a smaller selection.',
				]
					.filter(Boolean)
					.join('\n')
			}

			if (done && !String(editResult.summary ?? '').trim()) {
				done = false
				feedback =
					'You set done=true but summary is empty. Provide a concise summary including what changed and which A1 ranges were read to verify. Then output done=true.'
			}

			opts.instruments?.attempts?.add(1)

			const qcMode = opts.qualityCheckMode ?? 'auto'
			const shouldRunQc =
				done &&
				!!opts.qualityCheck &&
				(qcMode === 'always' || (qcMode === 'auto' && evaluation.wrote))
			if (shouldRunQc) {
				const qcSteps = clampInt(Math.floor(opts.maxStepsPerAttempt / 3), 2, 6)
				const qc = await opts.qualityCheck!.forward(
					ai,
					{
						instruction: String(s.instruction ?? '').trim(),
						summary: String(editResult.summary ?? ''),
						readScopes: s.readScopes,
						writeScopes: s.writeScopes,
						current: s.current,
						wrote: evaluation.wrote,
						verifiedAfterWrite: evaluation.verifiedAfterWrite,
						hadErrors: evaluation.hadErrors,
					},
					{ maxSteps: qcSteps, stepHooks: opts.stepHooks, traceLabel: 'univer/loopback:qa', asserts: QUALITY_ASSERTS },
				)

				quality = {
					ok: Boolean(qc.ok),
					confidence: Number(qc.confidence),
					feedback: String(qc.feedback ?? '').trim(),
				}

				if (!quality.ok || !(quality.confidence >= UNIVER_LOOPBACK_QA_CONFIDENCE_THRESHOLD)) {
					done = false
					feedback =
						quality.feedback ||
						`QA confidence too low (${quality.confidence}). Re-verify with targeted reads and fix any missing edits.`
				}
			}

			const attempt = s.attempt + 1
			if (opts.tracer) {
				const span = trace.getSpan(otelContext.active())
				span?.addEvent('univer.attempt', {
					attempt,
					maxAttempts: opts.maxAttempts,
					maxStepsPerAttempt: opts.maxStepsPerAttempt,
					toolCallsDelta,
					errorsDelta,
					wrote: evaluation.wrote,
					verifiedAfterWrite: evaluation.verifiedAfterWrite,
					hadErrors: evaluation.hadErrors,
					lastReadTool: String(opts.stats.lastReadTool ?? ''),
					lastWriteTool: String(opts.stats.lastWriteTool ?? ''),
					lastVerifyTool: String(opts.stats.lastVerifyTool ?? ''),
					lastErrorTool: String(opts.stats.lastErrorTool ?? ''),
					done,
					...(quality ? { 'qa.ok': quality.ok, 'qa.confidence': quality.confidence } : {}),
				})
			}

			return { ...s, attempt, feedback, editResult, done, evaluation, quality }
		})
		.feedback((s: AttemptState) => !s.done && s.attempt < opts.maxAttempts, 'attempt', opts.maxAttempts)
		.returns((s: AttemptState) => ({ done: s.done, summary: String(s.editResult.summary ?? ''), attempts: s.attempt }))

	return await loop.forward(ai, input, { autoParallel: false })
}
