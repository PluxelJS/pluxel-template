import type { Code, PollSpec, SelKind, VoteCtx } from './core.js'

export type NormalizedSpec = {
	spec: PollSpec
	choiceIndexById: Map<string, number>
	choiceCount: number
	maxSelections: number
	selectionKind: SelKind
}

type PersistedWeightSpec =
	| { kind: 'none' }
	| { kind: 'external'; min: string; max: string }

type PersistedSpec = Omit<PollSpec, 'weight'> & { weight?: PersistedWeightSpec; schemaVersion: 1 }

export function normalizeSpec(input: PollSpec): NormalizedSpec {
	const choices = [...input.choices]
	if (choices.length === 0) {
		throw new Error('[PollKernel] choices must not be empty')
	}
	const choiceIndexById = new Map<string, number>()
	for (let i = 0; i < choices.length; i += 1) {
		const id = choices[i]?.id
		if (!id) throw new Error('[PollKernel] choice id must not be empty')
		if (choiceIndexById.has(id)) throw new Error(`[PollKernel] duplicate choice id: ${id}`)
		choiceIndexById.set(id, i)
	}
	if (choices.length > 0xffff) {
		throw new Error('[PollKernel] choice count exceeds 65535 (u16 selection limit)')
	}

	const spec: PollSpec = {
		...input,
		choices,
		allowUpdate: input.allowUpdate ?? true,
		allowRetract: input.allowRetract ?? true,
		weight: input.weight ?? { kind: 'none' },
	}

	if (spec.weight?.kind === 'external' && spec.weight.min > spec.weight.max) {
		throw new Error('[PollKernel] weight.min must be <= weight.max')
	}

	if (spec.openAt !== undefined && spec.closeAt !== undefined && spec.openAt > spec.closeAt) {
		throw new Error('[PollKernel] openAt must be <= closeAt')
	}

	const choiceCount = choices.length
	const maxSelections =
		spec.mode === 'single'
			? 1
			: Math.min(Math.max(spec.maxSelections ?? choiceCount, 1), choiceCount)

	spec.maxSelections = maxSelections

	const selectionKind: SelKind = choiceCount <= 64 ? 'bitset64' : 'sortedU16'

	return {
		spec,
		choiceIndexById,
		choiceCount,
		maxSelections,
		selectionKind,
	}
}

export function resolveWeight(spec: PollSpec, ctx: VoteCtx): bigint | Code {
	const weight = spec.weight ?? { kind: 'none' }
	if (weight.kind === 'none') return 1n
	const w = ctx.weight
	if (w === undefined) return 'WEIGHT_INVALID'
	if (w < weight.min || w > weight.max) return 'WEIGHT_INVALID'
	if (w <= 0n) return 'WEIGHT_INVALID'
	return w
}

export function encodeSpec(spec: PollSpec): string {
	const weight = spec.weight ?? { kind: 'none' }
	const persisted: PersistedSpec = {
		...spec,
		schemaVersion: 1,
		weight:
			weight.kind === 'none'
				? { kind: 'none' }
				: { kind: 'external', min: weight.min.toString(10), max: weight.max.toString(10) },
	}
	return JSON.stringify(persisted)
}

export function decodeSpec(raw: string): PollSpec {
	const parsed = JSON.parse(raw) as PersistedSpec
	const weight = parsed.weight
	const spec: PollSpec = {
		...parsed,
		weight:
			weight && weight.kind === 'external'
				? { kind: 'external', min: BigInt(weight.min), max: BigInt(weight.max) }
				: { kind: 'none' },
	}
	delete (spec as { schemaVersion?: number }).schemaVersion
	return spec
}
