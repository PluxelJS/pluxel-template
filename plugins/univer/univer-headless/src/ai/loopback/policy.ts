import type { UniverToolGroup, UniverToolIndexMode } from '../../protocol'

export const UNIVER_LOOPBACK_TOOL_GROUPS: readonly UniverToolGroup[] = [
	'core',
	'data',
	'sheet',
	'structure',
	'style',
]

export const UNIVER_LOOPBACK_MAX_STEPS_TOTAL = 80
export const UNIVER_LOOPBACK_MAX_ATTEMPTS = 2
export const UNIVER_LOOPBACK_MAX_STEPS_PER_ATTEMPT = Math.floor(UNIVER_LOOPBACK_MAX_STEPS_TOTAL / UNIVER_LOOPBACK_MAX_ATTEMPTS)

export const UNIVER_LOOPBACK_QA_CONFIDENCE_THRESHOLD = 0.7

export function resolveToolIndexMode(groupsCount: number): UniverToolIndexMode {
	return groupsCount <= 2 ? 'tools' : 'groups'
}

