import type { AxAI } from '@ax-llm/ax'

import type { UniverToolIndexMode } from '../../protocol'
import type { UniverAiBridge } from '../bridge'
import { buildMcpToolIndexText } from '../mcp'
import { parseA1Range } from '../a1'
import type { Span } from '@opentelemetry/api'

import { buildContextPackText } from './context-pack'
import { resolveLoopLimits } from './limits'
import { createUniverAxOtelInstruments, spanError, spanOk, type UniverAxOtel } from './otel'
import { normalizeA1List } from './scopes'
import { classifyToolKind } from './tool-kind'
import { createUniverAxTools } from './tools'
import type { UniverAxLoopbackInput, UniverAxLoopbackResult } from './types'
import { runUniverLoopbackAttemptFlow } from './attempt-flow'
import { createUniverLoopbackEditorProgram, createUniverLoopbackQualityProgram, createUniverLoopbackStepHooks } from './programs'
import { buildUniverLoopbackEditorDefinition } from './prompt'
import { formatLoopbackAxError } from './ax-errors'
import {
	resolveToolIndexMode,
	resolveUniverLoopbackBudgets,
	resolveUniverLoopbackToolGroups,
} from './policy'

function resolvePromptMode(): 'compact' | 'full' {
	try {
		const v = String((process as any)?.env?.UNIVER_LOOPBACK_PROMPT ?? '').trim().toLowerCase()
		return v === 'full' ? 'full' : 'compact'
	} catch {
		return 'compact'
	}
}

function resolveQaMode(): 'off' | 'auto' | 'always' {
	try {
		const v = String((process as any)?.env?.UNIVER_LOOPBACK_QA ?? '').trim().toLowerCase()
		if (v === 'off' || v === '0' || v === 'false') return 'off'
		if (v === 'always') return 'always'
		return 'auto'
	} catch {
		return 'auto'
	}
}

export async function runUniverAxLoopback(
	ai: AxAI,
	bridge: UniverAiBridge,
	input: UniverAxLoopbackInput,
	opts?: { otel?: UniverAxOtel },
): Promise<UniverAxLoopbackResult> {
	const read = normalizeA1List(input.scopes.read)
	const write = normalizeA1List(input.scopes.write ?? [])
	const current = String(input.scopes.current ?? read[0] ?? '').trim()
	if (!read.length) throw new Error('[univer] read scopes must be non-empty')
	if (!current) throw new Error('[univer] current scope must be provided')

	for (const a1 of read) {
		const parsed = parseA1Range(a1)
		if (!parsed.sheetName) throw new Error('[univer] readScopes must be sheet-qualified (e.g. Sheet1!A1:B10)')
	}
	for (const a1 of write) {
		const parsed = parseA1Range(a1)
		if (!parsed.sheetName) throw new Error('[univer] writeScopes must be sheet-qualified (e.g. Sheet1!A1:B10)')
	}

	const groups = resolveUniverLoopbackToolGroups(String(input.instruction ?? ''))

	const effectiveLimits = resolveLoopLimits({
		limits: undefined,
		instruction: input.instruction,
		groups,
	})

	const { tools, stats, helpers } = createUniverAxTools(bridge, {
		current,
		readScopes: read,
		writeScopes: write,
		viewLimits: effectiveLimits,
		groups,
		otel: opts?.otel,
	})

	const toolIndexMode: UniverToolIndexMode = resolveToolIndexMode(groups.length)
	const toolIndexText = buildMcpToolIndexText(groups, { mode: toolIndexMode, includePresets: false })
	const contextPackScopes = (() => {
		const picked: string[] = []
		const seen = new Set<string>()
		for (const s of input.contexts?.selections ?? []) {
			const a1 = String(s?.selection?.a1 ?? '').trim()
			if (!a1 || seen.has(a1)) continue
			seen.add(a1)
			picked.push(a1)
		}
		if (current && !seen.has(current)) picked.push(current)
		for (const s of read) {
			if (!s || seen.has(s)) continue
			seen.add(s)
			picked.push(s)
		}
		return picked
	})()

	const tracer = opts?.otel?.tracer
	const instruments = createUniverAxOtelInstruments(opts?.otel?.meter)
	const budgets = resolveUniverLoopbackBudgets({
		instruction: String(input.instruction ?? ''),
		readScopesCount: read.length,
		writeScopesCount: write.length,
	})
	const promptMode = resolvePromptMode()
	const qaMode = resolveQaMode()

	let toolCallsAtStart = stats.toolCalls
	const makeErrorResult = (error: unknown, span?: Span): UniverAxLoopbackResult => {
		const { message, upstream } = formatLoopbackAxError(error)
		if (span && upstream) {
			try {
				if (typeof upstream.status === 'number') span.setAttribute('llm.http.status', upstream.status)
				if (upstream.statusText) span.setAttribute('llm.http.status_text', upstream.statusText)
				if (upstream.url) span.setAttribute('llm.http.url', upstream.url)
				if (upstream.errorId) span.setAttribute('llm.upstream.error_id', upstream.errorId)
				if (upstream.timestamp) span.setAttribute('llm.upstream.timestamp', upstream.timestamp)
				if (upstream.responseBodyPreview) span.addEvent('llm.upstream.body_preview', { preview: upstream.responseBodyPreview })
			} catch {
				// ignore
			}
		}
		const rounds = Math.max(1, stats.toolCalls - toolCallsAtStart)
		return { ok: false, error: message, stats, rounds }
	}

	const runInner = async (): Promise<UniverAxLoopbackResult> => {
		const contextPackText = await buildContextPackText(
			helpers.readRangeDisplay,
			contextPackScopes,
			effectiveLimits,
			input.contexts?.selections,
		)
			// Exclude bootstrap reads (context pack) from "rounds" accounting.
			toolCallsAtStart = stats.toolCalls

			const definition = buildUniverLoopbackEditorDefinition({
				contextPackText,
				toolGroups: groups,
				toolIndexText: promptMode === 'full' ? toolIndexText : '',
				readScopes: read,
				writeScopes: write,
				budgets,
				mode: promptMode,
			})
			const editor = createUniverLoopbackEditorProgram({ definition, tools })
			const stepHooks = createUniverLoopbackStepHooks(tracer)

		const readOnlyTools = tools.filter((t) => classifyToolKind(String(t.name ?? '')) !== 'write')
		const qualityCheck = qaMode === 'off' ? undefined : createUniverLoopbackQualityProgram({ tools: readOnlyTools })

		const out = await runUniverLoopbackAttemptFlow(
			ai,
			{ instruction: String(input.instruction ?? '').trim(), readScopes: read, writeScopes: write, current },
			{
				maxAttempts: budgets.maxAttempts,
				maxStepsPerAttempt: budgets.maxStepsPerAttempt,
				editor,
				qualityCheck,
				qualityCheckMode: qaMode,
				stats,
				stepHooks,
				tracer,
				instruments,
			},
		)

		const rounds = Math.max(1, stats.toolCalls - toolCallsAtStart)
		if (!out.done) {
			return {
				ok: false,
				error: `[univer] loopback unfinished (attempts=${out.attempts}/${budgets.maxAttempts}, maxStepsPerAttempt=${budgets.maxStepsPerAttempt}). Try narrowing read/write scopes or splitting the instruction.`,
				stats,
				rounds,
			}
		}
		return { ok: true, summary: out.summary, stats, rounds }
	}

	if (!tracer) {
		try {
			return await runInner()
		} catch (error) {
			return makeErrorResult(error)
		}
	}

	return await tracer.startActiveSpan(
		'univer.loopback',
		{
			attributes: {
				...(opts?.otel?.attributes ?? {}),
				'univer.max_steps_total': budgets.maxStepsTotal,
				'univer.max_attempts': budgets.maxAttempts,
				'univer.max_steps_per_attempt': budgets.maxStepsPerAttempt,
				'univer.tools.count': tools.length,
				'univer.tool_index_mode': toolIndexMode,
				'univer.groups': groups.join(','),
				'univer.read_scopes.count': read.length,
				'univer.write_scopes.count': write.length,
			},
		},
		async (span) => {
			try {
				const res = await runInner()
				if (res.ok) spanOk(span)
				else span.setStatus({ code: 2, message: res.error })
				return res
			} catch (error) {
				spanError(span, error)
				return makeErrorResult(error, span)
			} finally {
				span.end()
			}
		},
	)
}
