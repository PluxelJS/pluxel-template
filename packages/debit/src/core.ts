import { BasePlugin } from '@pluxel/hmr'
import type {
	Account,
	AccountBalance,
	AccountFilter,
	CreateAccountsError,
	CreateTransfersError,
	QueryFilter,
	Client as TigerBeetleClient,
	Transfer,
} from 'tigerbeetle-node'

/**
 * TigerBeetle-compatible client surface.
 *
 * This is intentionally kept *identical* to the official `tigerbeetle-node` `Client` interface so
 * downstream plugins can treat `Debit` as "the TigerBeetle client", just DI-provided.
 */
export type LedgerClient = TigerBeetleClient

export type DebitDriver = LedgerClient & {
	/**
	 * Optional cleanup hook for non-TigerBeetle implementations.
	 * Prefer `dispose()` for async cleanup.
	 */
	/** Optional cleanup hook (called by plugin stop). */
	dispose?: () => void | Promise<void>
}

/**
 * Ledger service token.
 *
 * Design goals (from `debit.md`):
 * - Reuse tigerbeetle-node request/response types and shapes
 * - Allow swapping backend (TigerBeetle / local simulation) without changing business code
 */
export abstract class Debit extends BasePlugin implements LedgerClient {
	private driverPromise: Promise<DebitDriver> | undefined
	private shutdown = false

	protected abstract createDriver(): DebitDriver | Promise<DebitDriver>

	protected async driver(): Promise<DebitDriver> {
		if (this.shutdown) throw new Error('Client was shutdown.')
		this.driverPromise ??= Promise.resolve(this.createDriver())
		return await this.driverPromise
	}

	/** Ensure the driver has been initialized. */
	async ready(): Promise<void> {
		await this.driver()
	}

	/**
	 * Low-level access to the underlying driver/client.
	 *
	 * Notes:
	 * - Prefer the `Debit` methods for portability.
	 * - This may expose backend-specific behavior.
	 */
	async raw(): Promise<DebitDriver> {
		return await this.driver()
	}

	destroy(): void {
		if (this.shutdown) return
		this.shutdown = true

		const promise = this.driverPromise
		this.driverPromise = undefined
		if (!promise) return

		// Best-effort shutdown for manual callers; plugin lifecycle uses `stop()` for awaited cleanup.
		void promise
			.then(async (driver) => {
				try {
					await driver.dispose?.()
				} finally {
					try {
						driver.destroy()
					} catch {
						// ignore
					}
				}
			})
			.catch(() => {
				// ignore
			})
	}

	async createAccounts(batch: Account[]): Promise<CreateAccountsError[]> {
		return await (await this.driver()).createAccounts(batch)
	}

	async lookupAccounts(batch: bigint[]): Promise<Account[]> {
		return await (await this.driver()).lookupAccounts(batch)
	}

	async createTransfers(batch: Transfer[]): Promise<CreateTransfersError[]> {
		return await (await this.driver()).createTransfers(batch)
	}

	async lookupTransfers(batch: bigint[]): Promise<Transfer[]> {
		return await (await this.driver()).lookupTransfers(batch)
	}

	async getAccountTransfers(filter: AccountFilter): Promise<Transfer[]> {
		return await (await this.driver()).getAccountTransfers(filter)
	}

	async getAccountBalances(filter: AccountFilter): Promise<AccountBalance[]> {
		return await (await this.driver()).getAccountBalances(filter)
	}

	async queryAccounts(filter: QueryFilter): Promise<Account[]> {
		return await (await this.driver()).queryAccounts(filter)
	}

	async queryTransfers(filter: QueryFilter): Promise<Transfer[]> {
		return await (await this.driver()).queryTransfers(filter)
	}

	protected override async stop(_abort: AbortSignal): Promise<void> {
		this.shutdown = true
		const promise = this.driverPromise
		this.driverPromise = undefined
		if (!promise) return

		const driver = await promise.catch(() => undefined)
		if (!driver) return

		try {
			await driver.dispose?.()
		} finally {
			try {
				driver.destroy()
			} catch {
				// ignore
			}
		}
	}
}
