import { describe, expect, it } from 'vitest'

import { evaluateUniverAxAttempt } from '../src/ai/loopback/attempt-eval'

describe('univer-headless: ax loopback attempt evaluation', () => {
	it('requires read-after-write verification even if model says done', () => {
		const res = evaluateUniverAxAttempt({
			attemptStartSeq: 10,
			lastWriteSeq: 12,
			lastReadSeq: 11,
			lastVerifySeq: 0,
			lastErrorSeq: 0,
			modelDone: true,
		})
		expect(res.wrote).toBe(true)
		expect(res.verifiedAfterWrite).toBe(false)
		expect(res.done).toBe(false)
		expect(res.feedback.toLowerCase()).toContain('verify')
	})

	it('accepts done when verified and no errors', () => {
		const res = evaluateUniverAxAttempt({
			attemptStartSeq: 0,
			lastWriteSeq: 2,
			lastReadSeq: 3,
			lastVerifySeq: 0,
			lastErrorSeq: 0,
			modelDone: true,
		})
		expect(res.wrote).toBe(true)
		expect(res.verifiedAfterWrite).toBe(true)
		expect(res.hadErrors).toBe(false)
		expect(res.done).toBe(true)
		expect(res.feedback).toBe('')
	})

	it('forces retry when there were tool errors and model says done', () => {
		const res = evaluateUniverAxAttempt({
			attemptStartSeq: 5,
			lastWriteSeq: 0,
			lastReadSeq: 0,
			lastVerifySeq: 0,
			lastErrorSeq: 6,
			modelDone: true,
		})
		expect(res.hadErrors).toBe(true)
		expect(res.done).toBe(false)
		expect(res.feedback.toLowerCase()).toContain('tool errors')
	})

	it('accepts write+readback within same tool call as verification', () => {
		const res = evaluateUniverAxAttempt({
			attemptStartSeq: 10,
			lastWriteSeq: 12,
			lastReadSeq: 11,
			lastVerifySeq: 12,
			lastErrorSeq: 0,
			modelDone: true,
		})
		expect(res.wrote).toBe(true)
		expect(res.verifiedAfterWrite).toBe(true)
		expect(res.done).toBe(true)
	})
})
