import { describe, expect, it } from 'bun:test'
import { BasePlugin, Plugin, withTestHost } from '@pluxel/core/test'
import {
	AccountFilterFlags,
	AccountFlags,
	amount_max,
	CreateTransferError,
	Ledger,
	newAccount,
	newTransferPending,
	newTransferPosted,
	newTransferPostPending,
	newTransferVoidPending,
	TransferFlags,
} from 'pluxel-plugin-ledger'
import { LedgerMikroOrm } from 'pluxel-plugin-ledger-mikro-orm'
import { MikroOrm, MikroOrmLibsql } from 'pluxel-plugin-mikro-orm'

@Plugin({ name: 'Caller', type: 'service' })
class Caller extends BasePlugin {
	constructor(public readonly ledger: Ledger) {
		super()
	}
}

async function withLedger<T>(
	fn: (deps: { mikro: MikroOrm; ledger: Ledger; caller: Caller }) => Promise<T>,
) {
	return await withTestHost(async (host) => {
		// In HMR runtime, ConfigService loads async; ensure our patches won't be overwritten by initial load.
		const cfg = host.ctx.configService as unknown as { ready?: Promise<void> }
		if (cfg.ready) await cfg.ready

		host.register(MikroOrmLibsql)
		host.register(LedgerMikroOrm)
		host.register(Caller)
		host.setConfig(MikroOrmLibsql, { config: { dbName: ':memory:', ensureSchemaOnInit: true } })
		host.setConfig(LedgerMikroOrm, {
			config: { scopeKey: 'ledger', ensureSchema: true, dropTableOnDispose: false },
		})
		await host.commitStrict()

		return await fn({
			mikro: host.getOrThrow(MikroOrm),
			ledger: host.getOrThrow(Ledger),
			caller: host.getOrThrow(Caller),
		})
	})
}

function findAccount<T extends { id: bigint }>(accounts: T[], id: bigint): T {
	const a = accounts.find((x) => x.id === id)
	if (!a) throw new Error(`missing account ${id.toString(10)}`)
	return a
}

describe('pluxel-plugin-ledger-mikro-orm', () => {
	it('posted transfer updates debits_posted/credits_posted', async () => {
		await withLedger(async ({ ledger }) => {
			const a = newAccount({ id: 1n, ledger: 1, code: 1 })
			const b = newAccount({ id: 2n, ledger: 1, code: 1 })
			expect(await ledger.createAccounts([a, b])).toEqual([])

			const t = newTransferPosted({
				id: 100n,
				debit_account_id: a.id,
				credit_account_id: b.id,
				amount: 50n,
				ledger: 1,
				code: 1,
			})
			expect(await ledger.createTransfers([t])).toEqual([])

			const accounts = await ledger.lookupAccounts([a.id, b.id])
			const a2 = findAccount(accounts, a.id)
			const b2 = findAccount(accounts, b.id)
			expect(a2.debits_posted).toBe(50n)
			expect(a2.credits_posted).toBe(0n)
			expect(b2.credits_posted).toBe(50n)
			expect(b2.debits_posted).toBe(0n)
			expect(a2.debits_pending).toBe(0n)
			expect(b2.credits_pending).toBe(0n)
		})
	})

	it('pending then post_full moves pending -> posted', async () => {
		await withLedger(async ({ ledger }) => {
			const a = newAccount({ id: 10n, ledger: 1, code: 1 })
			const b = newAccount({ id: 20n, ledger: 1, code: 1 })
			expect(await ledger.createAccounts([a, b])).toEqual([])

			const pending = newTransferPending({
				id: 200n,
				debit_account_id: a.id,
				credit_account_id: b.id,
				amount: 100n,
				ledger: 1,
				code: 1,
			})
			expect(await ledger.createTransfers([pending])).toEqual([])

			{
				const accounts = await ledger.lookupAccounts([a.id, b.id])
				const a2 = findAccount(accounts, a.id)
				const b2 = findAccount(accounts, b.id)
				expect(a2.debits_pending).toBe(100n)
				expect(b2.credits_pending).toBe(100n)
			}

			const post = newTransferPostPending({
				id: 201n,
				pending_id: pending.id,
				amount: amount_max,
			})
			expect(await ledger.createTransfers([post])).toEqual([])

			{
				const accounts = await ledger.lookupAccounts([a.id, b.id])
				const a2 = findAccount(accounts, a.id)
				const b2 = findAccount(accounts, b.id)
				expect(a2.debits_pending).toBe(0n)
				expect(b2.credits_pending).toBe(0n)
				expect(a2.debits_posted).toBe(100n)
				expect(b2.credits_posted).toBe(100n)
			}
		})
	})

	it('pending then void releases pending without posted', async () => {
		await withLedger(async ({ ledger }) => {
			const a = newAccount({ id: 11n, ledger: 1, code: 1 })
			const b = newAccount({ id: 21n, ledger: 1, code: 1 })
			expect(await ledger.createAccounts([a, b])).toEqual([])

			const pending = newTransferPending({
				id: 300n,
				debit_account_id: a.id,
				credit_account_id: b.id,
				amount: 70n,
				ledger: 1,
				code: 1,
			})
			expect(await ledger.createTransfers([pending])).toEqual([])

			const voided = newTransferVoidPending({ id: 301n, pending_id: pending.id })
			expect(await ledger.createTransfers([voided])).toEqual([])

			const accounts = await ledger.lookupAccounts([a.id, b.id])
			const a2 = findAccount(accounts, a.id)
			const b2 = findAccount(accounts, b.id)
			expect(a2.debits_pending).toBe(0n)
			expect(b2.credits_pending).toBe(0n)
			expect(a2.debits_posted).toBe(0n)
			expect(b2.credits_posted).toBe(0n)
		})
	})

	it('linked chain rolls back and returns linked_event_failed for others', async () => {
		await withLedger(async ({ ledger }) => {
			const a = newAccount({ id: 1000n, ledger: 1, code: 1 })
			const b = newAccount({ id: 2000n, ledger: 1, code: 1 })
			expect(await ledger.createAccounts([a, b])).toEqual([])

			const t0 = newTransferPosted({
				id: 400n,
				debit_account_id: 9999n,
				credit_account_id: b.id,
				amount: 5n,
				ledger: 1,
				code: 1,
				flags: TransferFlags.linked,
			})
			const t1 = newTransferPosted({
				id: 401n,
				debit_account_id: a.id,
				credit_account_id: b.id,
				amount: 5n,
				ledger: 1,
				code: 1,
			})

			const errors = await ledger.createTransfers([t0, t1])
			expect(errors).toEqual([
				{ index: 0, result: CreateTransferError.debit_account_not_found },
				{ index: 1, result: CreateTransferError.linked_event_failed },
			])

			expect(await ledger.lookupTransfers([t0.id, t1.id])).toEqual([])
			const accounts = await ledger.lookupAccounts([a.id, b.id])
			expect(findAccount(accounts, a.id).debits_posted).toBe(0n)
			expect(findAccount(accounts, b.id).credits_posted).toBe(0n)
		})
	})

	it('enforces debits_must_not_exceed_credits in common cases', async () => {
		await withLedger(async ({ ledger }) => {
			const bank = newAccount({ id: 1n, ledger: 1, code: 1 })
			const user = newAccount({
				id: 2n,
				ledger: 1,
				code: 1,
				flags: AccountFlags.debits_must_not_exceed_credits,
			})
			expect(await ledger.createAccounts([bank, user])).toEqual([])

			// Deposit: user gets credits_posted = 100.
			expect(
				await ledger.createTransfers([
					newTransferPosted({
						id: 500n,
						debit_account_id: bank.id,
						credit_account_id: user.id,
						amount: 100n,
						ledger: 1,
						code: 1,
					}),
				]),
			).toEqual([])

			// Spend 150 should fail (exceeds_credits).
			const spend = newTransferPosted({
				id: 501n,
				debit_account_id: user.id,
				credit_account_id: bank.id,
				amount: 150n,
				ledger: 1,
				code: 1,
			})
			const errors = await ledger.createTransfers([spend])
			expect(errors).toEqual([{ index: 0, result: CreateTransferError.exceeds_credits }])
		})
	})

	it('getAccountTransfers and getAccountBalances align by timestamp', async () => {
		await withLedger(async ({ ledger }) => {
			const a = newAccount({ id: 7000n, ledger: 1, code: 1 })
			const b = newAccount({ id: 8000n, ledger: 1, code: 1 })
			expect(await ledger.createAccounts([a, b])).toEqual([])

			expect(
				await ledger.createTransfers([
					newTransferPosted({
						id: 600n,
						debit_account_id: a.id,
						credit_account_id: b.id,
						amount: 10n,
						ledger: 1,
						code: 1,
					}),
					newTransferPosted({
						id: 601n,
						debit_account_id: a.id,
						credit_account_id: b.id,
						amount: 5n,
						ledger: 1,
						code: 1,
					}),
				]),
			).toEqual([])

			const filter = {
				account_id: a.id,
				user_data_128: 0n,
				user_data_64: 0n,
				user_data_32: 0,
				code: 0,
				timestamp_min: 0n,
				timestamp_max: 0n,
				limit: 10,
				flags: AccountFilterFlags.debits,
			}

			const transfers = await ledger.getAccountTransfers(filter)
			const balances = await ledger.getAccountBalances(filter)
			expect(balances.length).toBe(transfers.length)
			expect(transfers.length).toBe(2)

			expect(balances[0]!.timestamp).toBe(transfers[0]!.timestamp)
			expect(balances[1]!.timestamp).toBe(transfers[1]!.timestamp)
			expect(balances[0]!.debits_posted).toBe(10n)
			expect(balances[1]!.debits_posted).toBe(15n)
		})
	})
})
