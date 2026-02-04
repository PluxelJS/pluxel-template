import {
	type Account,
	AccountFlags,
	amount_max,
	type Transfer,
	TransferFlags,
} from 'tigerbeetle-node'

export type NewAccountInput = {
	id: bigint
	ledger: number
	code: number
	flags?: number
	user_data_128?: bigint
	user_data_64?: bigint
	user_data_32?: number
}

export function newAccount(input: NewAccountInput): Account {
	return {
		id: input.id,
		ledger: input.ledger,
		code: input.code,
		flags: input.flags ?? AccountFlags.none,

		debits_pending: 0n,
		debits_posted: 0n,
		credits_pending: 0n,
		credits_posted: 0n,

		user_data_128: input.user_data_128 ?? 0n,
		user_data_64: input.user_data_64 ?? 0n,
		user_data_32: input.user_data_32 ?? 0,

		reserved: 0,
		timestamp: 0n,
	}
}

export type NewTransferCommon = {
	id: bigint
	debit_account_id: bigint
	credit_account_id: bigint
	amount: bigint
	ledger: number
	code: number
	flags?: number
	user_data_128?: bigint
	user_data_64?: bigint
	user_data_32?: number
	timeout?: number
}

export function newTransferPosted(input: NewTransferCommon): Transfer {
	return {
		id: input.id,
		debit_account_id: input.debit_account_id,
		credit_account_id: input.credit_account_id,
		amount: input.amount,
		pending_id: 0n,
		user_data_128: input.user_data_128 ?? 0n,
		user_data_64: input.user_data_64 ?? 0n,
		user_data_32: input.user_data_32 ?? 0,
		timeout: input.timeout ?? 0,
		ledger: input.ledger,
		code: input.code,
		flags: (input.flags ?? TransferFlags.none) & ~TransferFlags.pending,
		timestamp: 0n,
	}
}

export function newTransferPending(input: NewTransferCommon): Transfer {
	return {
		...newTransferPosted(input),
		flags: (input.flags ?? TransferFlags.none) | TransferFlags.pending,
	}
}

export type NewTransferPostPendingInput = {
	id: bigint
	pending_id: bigint
	/** 0/amount_max are accepted by TigerBeetle semantics. */
	amount: bigint
	flags?: number
	/**
	 * Inheritables: pass 0 to inherit from pending transfer.
	 * If non-zero, must match the pending transfer.
	 */
	debit_account_id?: bigint
	credit_account_id?: bigint
	ledger?: number
	code?: number
	user_data_128?: bigint
	user_data_64?: bigint
	user_data_32?: number
	timeout?: number
}

export function newTransferPostPending(input: NewTransferPostPendingInput): Transfer {
	return {
		id: input.id,
		debit_account_id: input.debit_account_id ?? 0n,
		credit_account_id: input.credit_account_id ?? 0n,
		amount: input.amount,
		pending_id: input.pending_id,
		user_data_128: input.user_data_128 ?? 0n,
		user_data_64: input.user_data_64 ?? 0n,
		user_data_32: input.user_data_32 ?? 0,
		timeout: input.timeout ?? 0,
		ledger: input.ledger ?? 0,
		code: input.code ?? 0,
		flags:
			((input.flags ?? TransferFlags.none) | TransferFlags.post_pending_transfer) &
			~TransferFlags.void_pending_transfer,
		timestamp: 0n,
	}
}

export type NewTransferVoidPendingInput = {
	id: bigint
	pending_id: bigint
	/** 0 means "void full amount" (TigerBeetle). */
	amount?: bigint
	flags?: number
	debit_account_id?: bigint
	credit_account_id?: bigint
	ledger?: number
	code?: number
	user_data_128?: bigint
	user_data_64?: bigint
	user_data_32?: number
	timeout?: number
}

export function newTransferVoidPending(input: NewTransferVoidPendingInput): Transfer {
	return {
		id: input.id,
		debit_account_id: input.debit_account_id ?? 0n,
		credit_account_id: input.credit_account_id ?? 0n,
		amount: input.amount ?? 0n,
		pending_id: input.pending_id,
		user_data_128: input.user_data_128 ?? 0n,
		user_data_64: input.user_data_64 ?? 0n,
		user_data_32: input.user_data_32 ?? 0,
		timeout: input.timeout ?? 0,
		ledger: input.ledger ?? 0,
		code: input.code ?? 0,
		flags:
			((input.flags ?? TransferFlags.none) | TransferFlags.void_pending_transfer) &
			~TransferFlags.post_pending_transfer,
		timestamp: 0n,
	}
}

export { amount_max }
