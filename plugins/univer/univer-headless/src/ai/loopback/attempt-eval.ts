export type UniverAxAttemptEvaluation = Readonly<{
	done: boolean
	feedback: string
	wrote: boolean
	verifiedAfterWrite: boolean
	hadErrors: boolean
}>

export function evaluateUniverAxAttempt(input: Readonly<{
	attemptStartSeq: number
	lastWriteSeq: number
	lastReadSeq: number
	lastVerifySeq?: number
	lastErrorSeq: number
	modelDone: boolean
}>): UniverAxAttemptEvaluation {
	const attemptStartSeq = Number.isFinite(input.attemptStartSeq) ? input.attemptStartSeq : 0
	const lastWriteSeq = Number.isFinite(input.lastWriteSeq) ? input.lastWriteSeq : 0
	const lastReadSeq = Number.isFinite(input.lastReadSeq) ? input.lastReadSeq : 0
	const lastVerifySeq = Number.isFinite(input.lastVerifySeq) ? Number(input.lastVerifySeq) : 0
	const lastErrorSeq = Number.isFinite(input.lastErrorSeq) ? input.lastErrorSeq : 0
	const modelDone = Boolean(input.modelDone)

	const wrote = lastWriteSeq > attemptStartSeq
	const verifiedAfterWrite = !wrote || lastReadSeq > lastWriteSeq || (lastVerifySeq >= lastWriteSeq && lastVerifySeq > attemptStartSeq)
	const hadErrors = lastErrorSeq > attemptStartSeq

	let done = modelDone
	let feedback = ''

	if (wrote && !verifiedAfterWrite) {
		done = false
		feedback =
			'You performed writes but did not verify after the last write. Read back the minimal affected output range(s) and confirm they match the instruction. Then output done=true.'
	} else if (hadErrors && modelDone) {
		done = false
		feedback =
			'Tool errors occurred in this attempt. Resolve the errors, re-run the necessary tool calls, and verify by reading back results. Then output done=true.'
	} else if (!modelDone) {
		feedback =
			'Not done yet. Continue from the current workbook state, minimize tool calls, batch edits, and verify after any write. Output done=true when complete.'
	}

	return { done, feedback, wrote, verifiedAfterWrite, hadErrors }
}
