import { Config, Plugin, setParamToken } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { Ledger, type LedgerDriver } from 'pluxel-plugin-ledger'
import { MikroOrm } from 'pluxel-plugin-mikro-orm'
import { EntitySchema } from 'pluxel-plugin-mikro-orm/mikro-orm/core'
import {
	type Account,
	type AccountBalance,
	type AccountFilter,
	AccountFilterFlags,
	AccountFlags,
	amount_max,
	CreateAccountError,
	type CreateAccountsError,
	CreateTransferError,
	type CreateTransfersError,
	type QueryFilter,
	QueryFilterFlags,
	type Transfer,
	TransferFlags,
} from 'tigerbeetle-node'

// Ensure `emitDecoratorMetadata` can see the runtime class for DI (avoid resolving to `Object`).
void MikroOrm

export const LedgerMikroOrmConfigSchema = v.object({
	/** Stable scopeKey for table prefixing (defaults to `ledger`). */
	scopeKey: v.optional(v.string(), 'ledger'),
	/** Auto create/update tables on startup (default true). */
	ensureSchema: v.optional(v.boolean(), true),
	/** Drop tables on dispose (default false, use with care). */
	dropTableOnDispose: v.optional(v.boolean(), false),
})

export type LedgerMikroOrmConfig = Config<typeof LedgerMikroOrmConfigSchema>

type Tables = {
	accounts: string
	transfers: string
	pending: string
	clock: string
	dispose: () => Promise<void>
}

type PendingRow = {
	pending_id: string
	resolution: string | null
	resolution_transfer_id: string | null
	resolved_timestamp: string | null
	posted_amount: string | null
	expires_at_ms: number | null
}

type SqlEntityManager = {
	execute: (sql: string, params?: unknown[], method?: 'all' | 'get' | 'run') => Promise<unknown>
	transactional: <T>(fn: (em: SqlEntityManager) => Promise<T>) => Promise<T>
}

type TimestampAllocator = {
	next: () => string
	checkpoint: () => bigint
	restore: (checkpoint: bigint) => void
	flush: () => Promise<void>
}

function hasFlag(flags: number, bit: number): boolean {
	return (flags & bit) !== 0
}

const SUPPORTED_ACCOUNT_FLAGS =
	AccountFlags.linked |
	AccountFlags.debits_must_not_exceed_credits |
	AccountFlags.credits_must_not_exceed_debits

const SUPPORTED_TRANSFER_FLAGS =
	TransferFlags.linked |
	TransferFlags.pending |
	TransferFlags.post_pending_transfer |
	TransferFlags.void_pending_transfer

const U128_MAX = (1n << 128n) - 1n

const TS_WIDTH = 20

function formatTs(ts: bigint): string {
	if (ts < 0n) throw new Error('[LedgerMikroOrm] timestamp must be >= 0')
	const s = ts.toString(10)
	if (s.length > TS_WIDTH) {
		throw new Error(`[LedgerMikroOrm] timestamp too large (>${TS_WIDTH} digits)`)
	}
	return s.padStart(TS_WIDTH, '0')
}

function unboundedMin(v: bigint): string | undefined {
	return v === 0n ? undefined : formatTs(v)
}

function unboundedMax(v: bigint): string | undefined {
	return v === 0n ? undefined : formatTs(v)
}

function stripLinkedAccountFlags(flags: number): number {
	return flags & ~AccountFlags.linked
}

function stripLinkedTransferFlags(flags: number): number {
	return flags & ~TransferFlags.linked
}

function u128ToDb(v: bigint): string {
	return v.toString(10)
}

function u128FromDb(v: string): bigint {
	return BigInt(v)
}

function isU128Max(v: bigint): boolean {
	return v === U128_MAX
}

function quoteIdent(ident: string): string {
	// MikroOrm adds prefixes; identifiers here are expected to be safe but we still quote.
	return `"${ident.replaceAll('"', '""')}"`
}

function resultRows<T>(r: unknown): T[] {
	return Array.isArray(r) ? (r as T[]) : []
}

function requiredString(row: Record<string, unknown>, key: string): string {
	const v = row[key]
	if (v == null) throw new Error(`[LedgerMikroOrm] missing column: ${key}`)
	return String(v)
}

function requiredNumber(row: Record<string, unknown>, key: string): number {
	const v = row[key]
	if (v == null) throw new Error(`[LedgerMikroOrm] missing column: ${key}`)
	return Number(v)
}

type AccountRow = Record<string, unknown>
type TransferRow = Record<string, unknown>

function mapAccountRow(r: AccountRow): Account {
	return {
		id: u128FromDb(requiredString(r, 'id')),
		ledger: requiredNumber(r, 'ledger'),
		code: requiredNumber(r, 'code'),
		flags: requiredNumber(r, 'flags'),
		timestamp: BigInt(requiredString(r, 'timestamp')),
		debits_pending: u128FromDb(requiredString(r, 'debits_pending')),
		debits_posted: u128FromDb(requiredString(r, 'debits_posted')),
		credits_pending: u128FromDb(requiredString(r, 'credits_pending')),
		credits_posted: u128FromDb(requiredString(r, 'credits_posted')),
		user_data_128: u128FromDb(requiredString(r, 'user_data_128')),
		user_data_64: u128FromDb(requiredString(r, 'user_data_64')),
		user_data_32: requiredNumber(r, 'user_data_32'),
		reserved: requiredNumber(r, 'reserved'),
	}
}

function mapTransferRow(r: TransferRow): Transfer {
	return {
		id: u128FromDb(requiredString(r, 'id')),
		debit_account_id: u128FromDb(requiredString(r, 'debit_account_id')),
		credit_account_id: u128FromDb(requiredString(r, 'credit_account_id')),
		amount: u128FromDb(requiredString(r, 'amount')),
		pending_id: u128FromDb(requiredString(r, 'pending_id')),
		user_data_128: u128FromDb(requiredString(r, 'user_data_128')),
		user_data_64: u128FromDb(requiredString(r, 'user_data_64')),
		user_data_32: requiredNumber(r, 'user_data_32'),
		timeout: requiredNumber(r, 'timeout'),
		ledger: requiredNumber(r, 'ledger'),
		code: requiredNumber(r, 'code'),
		flags: requiredNumber(r, 'flags'),
		timestamp: BigInt(requiredString(r, 'timestamp')),
	}
}

type Segment = { start: number; end: number; open: boolean }

function splitLinkedSegments<T>(batch: T[], isLinked: (t: T) => boolean): Segment[] {
	const segments: Segment[] = []
	for (let i = 0; i < batch.length; ) {
		const start = i
		let open = false
		while (true) {
			const last = batch[i]!
			const linked = isLinked(last)
			i += 1
			if (!linked) break
			if (i >= batch.length) {
				open = true
				break
			}
		}
		segments.push({ start, end: batch.length < i ? batch.length : i, open })
		if (open) break
	}
	return segments
}

type BalanceState = {
	debits_pending: bigint
	debits_posted: bigint
	credits_pending: bigint
	credits_posted: bigint
}

function applyReleasePending(state: BalanceState, accountId: bigint, pending: Transfer): void {
	if (pending.debit_account_id === accountId) state.debits_pending -= pending.amount
	if (pending.credit_account_id === accountId) state.credits_pending -= pending.amount
}

function applyTransferToAccountState(
	state: BalanceState,
	accountId: bigint,
	transfer: Transfer,
	pendingById: Map<string, Transfer>,
): void {
	const flags = transfer.flags
	const isPending = hasFlag(flags, TransferFlags.pending)
	const isPost = hasFlag(flags, TransferFlags.post_pending_transfer)
	const isVoid = hasFlag(flags, TransferFlags.void_pending_transfer)

	if (isPost || isVoid) {
		const pending = pendingById.get(u128ToDb(transfer.pending_id))
		if (!pending) {
			throw new Error(
				`[LedgerMikroOrm] missing pending transfer referenced by ${u128ToDb(transfer.id)} pending_id=${u128ToDb(transfer.pending_id)}`,
			)
		}

		applyReleasePending(state, accountId, pending)
		if (isPost) {
			if (pending.debit_account_id === accountId) state.debits_posted += transfer.amount
			if (pending.credit_account_id === accountId) state.credits_posted += transfer.amount
		}
		return
	}

	if (isPending) {
		if (transfer.debit_account_id === accountId) state.debits_pending += transfer.amount
		if (transfer.credit_account_id === accountId) state.credits_pending += transfer.amount
		return
	}

	// posted
	if (transfer.debit_account_id === accountId) state.debits_posted += transfer.amount
	if (transfer.credit_account_id === accountId) state.credits_posted += transfer.amount
}

@Plugin(Ledger, { name: 'MikroORM', type: 'service' })
export class LedgerMikroOrm extends Ledger {
	@Config(LedgerMikroOrmConfigSchema)
	private config!: LedgerMikroOrmConfig

	constructor(private readonly mikro: MikroOrm) {
		super()
	}

	private tablesPromise: Promise<Tables> | undefined

	protected override init(_abort: AbortSignal): void {
		// Validate early for faster feedback in dev.
		void this.ensureTables()
	}

	protected createDriver(): LedgerDriver {
		return {
			createAccounts: async (accounts) => await this.createAccountsDb(accounts),
			lookupAccounts: async (ids) => await this.lookupAccountsDb(ids),
			createTransfers: async (transfers) => await this.createTransfersDb(transfers),
			lookupTransfers: async (ids) => await this.lookupTransfersDb(ids),
			getAccountTransfers: async (filter) => await this.getAccountTransfersDb(filter),
			getAccountBalances: async (filter) => await this.getAccountBalancesDb(filter),
			queryAccounts: async (filter) => await this.queryAccountsDb(filter),
			queryTransfers: async (filter) => await this.queryTransfersDb(filter),
			destroy: () => {
				// no-op: plugin lifecycle calls `dispose()` for awaited cleanup
			},
			dispose: async () => {
				const t = await this.ensureTables()
				await t.dispose()
			},
		}
	}

	private async ensureTables(): Promise<Tables> {
		this.tablesPromise ??= (async () => {
			const scopeKey = String(this.config.scopeKey ?? 'ledger').trim()
			if (!scopeKey) throw new Error('[LedgerMikroOrm] invalid config: scopeKey')

			const scope = this.mikro.scope(scopeKey)
			const ensureSchema = this.config.ensureSchema ?? true
			const dropTableOnDispose = this.config.dropTableOnDispose ?? false

			const AccountRow = new EntitySchema({
				name: 'LedgerAccount',
				tableName: 'accounts',
				properties: {
					id: { primary: true, type: 'string' },
					ledger: { type: 'number' },
					code: { type: 'number' },
					flags: { type: 'number' },
					timestamp: { type: 'string' },
					debits_pending: { type: 'string' },
					debits_posted: { type: 'string' },
					credits_pending: { type: 'string' },
					credits_posted: { type: 'string' },
					user_data_128: { type: 'string' },
					user_data_64: { type: 'string' },
					user_data_32: { type: 'number' },
					reserved: { type: 'number' },
				},
			})
			AccountRow.addIndex({ properties: ['timestamp'] })
			AccountRow.addIndex({ properties: ['code'] })
			AccountRow.addIndex({ properties: ['ledger'] })
			AccountRow.addIndex({ properties: ['user_data_128'] })
			AccountRow.addIndex({ properties: ['user_data_64'] })
			AccountRow.addIndex({ properties: ['user_data_32'] })

			const TransferRow = new EntitySchema({
				name: 'LedgerTransfer',
				tableName: 'transfers',
				properties: {
					id: { primary: true, type: 'string' },
					debit_account_id: { type: 'string' },
					credit_account_id: { type: 'string' },
					amount: { type: 'string' },
					pending_id: { type: 'string' },
					user_data_128: { type: 'string' },
					user_data_64: { type: 'string' },
					user_data_32: { type: 'number' },
					timeout: { type: 'number' },
					ledger: { type: 'number' },
					code: { type: 'number' },
					flags: { type: 'number' },
					timestamp: { type: 'string' },
				},
			})
			TransferRow.addIndex({ properties: ['timestamp'] })
			TransferRow.addIndex({ properties: ['debit_account_id'] })
			TransferRow.addIndex({ properties: ['credit_account_id'] })
			TransferRow.addIndex({ properties: ['pending_id'] })
			TransferRow.addIndex({ properties: ['code'] })
			TransferRow.addIndex({ properties: ['ledger'] })
			TransferRow.addIndex({ properties: ['user_data_128'] })
			TransferRow.addIndex({ properties: ['user_data_64'] })
			TransferRow.addIndex({ properties: ['user_data_32'] })

			const PendingResolutionRow = new EntitySchema({
				name: 'LedgerPendingResolution',
				tableName: 'pending_resolution',
				properties: {
					pending_id: { primary: true, type: 'string' },
					resolution: { type: 'string', nullable: true },
					resolution_transfer_id: { type: 'string', nullable: true },
					resolved_timestamp: { type: 'string', nullable: true },
					posted_amount: { type: 'string', nullable: true },
					expires_at_ms: { type: 'number', nullable: true },
				},
			})
			PendingResolutionRow.addIndex({ properties: ['expires_at_ms'] })
			PendingResolutionRow.addIndex({ properties: ['resolved_timestamp'] })
			PendingResolutionRow.addIndex({ properties: ['resolution'] })

			const ClusterClockRow = new EntitySchema({
				name: 'LedgerClusterClock',
				tableName: 'cluster_clock',
				properties: {
					key: { primary: true, type: 'string' },
					last_timestamp: { type: 'string' },
				},
			})

			const batch = await scope.registerEntities(
				[AccountRow, TransferRow, PendingResolutionRow, ClusterClockRow],
				{
					ensureSchema,
					dropTableOnDispose,
				},
			)

			const map = new Map(batch.entities.map((e) => [e.baseTableName, e.tableName]))
			const get = (base: string) => {
				const t = map.get(base)
				if (!t) throw new Error(`[LedgerMikroOrm] internal error: missing table ${base}`)
				return t
			}

			return {
				accounts: get('accounts'),
				transfers: get('transfers'),
				pending: get('pending_resolution'),
				clock: get('cluster_clock'),
				dispose: batch.dispose,
			}
		})()

		return await this.tablesPromise
	}

	private async lookupAccountsDb(ids: bigint[]): Promise<Account[]> {
		if (ids.length === 0) return []

		const t = await this.ensureTables()
		const em = (await this.mikro.sqlEm()) as unknown as SqlEntityManager

		const params = ids.map(u128ToDb)
		const placeholders = params.map(() => '?').join(',')
		const rows = resultRows<Record<string, unknown>>(
			await em.execute(
				`SELECT * FROM ${quoteIdent(t.accounts)} WHERE id IN (${placeholders})`,
				params,
				'all',
			),
		)

		return rows.map(mapAccountRow)
	}

	private async lookupTransfersDb(ids: bigint[]): Promise<Transfer[]> {
		if (ids.length === 0) return []

		const t = await this.ensureTables()
		const em = (await this.mikro.sqlEm()) as unknown as SqlEntityManager

		const params = ids.map(u128ToDb)
		const placeholders = params.map(() => '?').join(',')
		const rows = resultRows<Record<string, unknown>>(
			await em.execute(
				`SELECT * FROM ${quoteIdent(t.transfers)} WHERE id IN (${placeholders})`,
				params,
				'all',
			),
		)

		return rows.map(mapTransferRow)
	}

	private async getAccountTransfersDb(filter: AccountFilter): Promise<Transfer[]> {
		const t = await this.ensureTables()
		const em = (await this.mikro.sqlEm()) as unknown as SqlEntityManager

		const includeDebit = hasFlag(filter.flags, AccountFilterFlags.debits)
		const includeCredit = hasFlag(filter.flags, AccountFilterFlags.credits)
		const reversed = hasFlag(filter.flags, AccountFilterFlags.reversed)
		const limit = Math.max(0, Math.floor(filter.limit ?? 0))
		if (limit === 0) return []
		if (!includeDebit && !includeCredit) return []

		const where: string[] = []
		const params: unknown[] = []

		const accountId = u128ToDb(filter.account_id)
		const sides: string[] = []
		if (includeDebit) {
			sides.push('debit_account_id = ?')
			params.push(accountId)
		}
		if (includeCredit) {
			sides.push('credit_account_id = ?')
			params.push(accountId)
		}
		where.push(`(${sides.join(' OR ')})`)

		if (filter.code !== 0) {
			where.push('code = ?')
			params.push(filter.code)
		}
		if (filter.user_data_128 !== 0n) {
			where.push('user_data_128 = ?')
			params.push(u128ToDb(filter.user_data_128))
		}
		if (filter.user_data_64 !== 0n) {
			where.push('user_data_64 = ?')
			params.push(u128ToDb(filter.user_data_64))
		}
		if (filter.user_data_32 !== 0) {
			where.push('user_data_32 = ?')
			params.push(filter.user_data_32)
		}

		const min = unboundedMin(filter.timestamp_min)
		if (min) {
			where.push('timestamp >= ?')
			params.push(min)
		}
		const max = unboundedMax(filter.timestamp_max)
		if (max) {
			where.push('timestamp <= ?')
			params.push(max)
		}

		const sql = `SELECT * FROM ${quoteIdent(t.transfers)}
			WHERE ${where.join(' AND ')}
			ORDER BY timestamp ${reversed ? 'DESC' : 'ASC'}
			LIMIT ${limit}`

		const rows = resultRows<TransferRow>(await em.execute(sql, params, 'all'))
		return rows.map(mapTransferRow)
	}

	private async getAccountBalancesDb(filter: AccountFilter): Promise<AccountBalance[]> {
		// TigerBeetle returns balances aligned with `getAccountTransfers(filter)` and matching timestamps.
		// We compute them by replaying all transfers affecting the account up to the latest returned transfer.
		const transfers = await this.getAccountTransfersDb(filter)
		if (transfers.length === 0) return []

		const accountId = filter.account_id
		const accountIdDb = u128ToDb(accountId)

		const requestedByTs = new Map<string, true>()
		let maxTs = 0n
		for (const tr of transfers) {
			const ts = tr.timestamp
			if (ts > maxTs) maxTs = ts
			requestedByTs.set(ts.toString(10), true)
		}

		const t = await this.ensureTables()
		const em = (await this.mikro.sqlEm()) as unknown as SqlEntityManager

		const allTransferRows = resultRows<TransferRow>(
			await em.execute(
				`SELECT * FROM ${quoteIdent(t.transfers)}
				 WHERE (debit_account_id = ? OR credit_account_id = ?)
				   AND timestamp <= ?
				 ORDER BY timestamp ASC`,
				[accountIdDb, accountIdDb, formatTs(maxTs)],
				'all',
			),
		)

		const allTransfers = allTransferRows.map(mapTransferRow)
		const byId = new Map<string, Transfer>()
		for (const tr of allTransfers) byId.set(u128ToDb(tr.id), tr)

		// Include expiration events (not represented as a transfer row in our local model).
		const expiredRows = resultRows<Record<string, unknown>>(
			await em.execute(
				`SELECT p.pending_id as pending_id,
				        p.resolved_timestamp as resolved_timestamp
				 FROM ${quoteIdent(t.pending)} p
				 JOIN ${quoteIdent(t.transfers)} tr ON tr.id = p.pending_id
				 WHERE p.resolution = 'expired'
				   AND p.resolved_timestamp IS NOT NULL
				   AND (tr.debit_account_id = ? OR tr.credit_account_id = ?)
				   AND p.resolved_timestamp <= ?`,
				[accountIdDb, accountIdDb, formatTs(maxTs)],
				'all',
			),
		)

		const expireEvents: Array<{ timestamp: bigint; pending: Transfer }> = []
		for (const r of expiredRows) {
			const pendingIdDb = requiredString(r, 'pending_id')
			const pending = byId.get(pendingIdDb)
			if (!pending) {
				throw new Error(`[LedgerMikroOrm] missing pending transfer for expiration: ${pendingIdDb}`)
			}
			const ts = BigInt(requiredString(r, 'resolved_timestamp'))
			expireEvents.push({ timestamp: ts, pending })
		}
		expireEvents.sort((a, b) =>
			a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
		)

		const state: BalanceState = {
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
		}

		const pendingById = new Map<string, Transfer>()
		const balancesByTimestamp = new Map<string, AccountBalance>()

		let expireIndex = 0
		for (const tr of allTransfers) {
			// Apply expiration events that happened before this transfer.
			while (
				expireIndex < expireEvents.length &&
				expireEvents[expireIndex]!.timestamp < tr.timestamp
			) {
				const pending = expireEvents[expireIndex]!.pending
				applyReleasePending(state, accountId, pending)
				expireIndex += 1
			}

			// Track pending transfers for later resolution replay.
			if (hasFlag(tr.flags, TransferFlags.pending)) {
				pendingById.set(u128ToDb(tr.id), tr)
			}

			applyTransferToAccountState(state, accountId, tr, pendingById)

			const key = tr.timestamp.toString(10)
			if (requestedByTs.has(key)) {
				balancesByTimestamp.set(key, { ...state, timestamp: tr.timestamp })
			}
		}

		// Apply any remaining expiration events after the last transfer (rare but possible if the last returned
		// transfer isn't the latest event up to maxTs).
		while (expireIndex < expireEvents.length) {
			const pending = expireEvents[expireIndex]!.pending
			applyReleasePending(state, accountId, pending)
			expireIndex += 1
		}

		return transfers.map((tr) => {
			const b = balancesByTimestamp.get(tr.timestamp.toString(10))
			if (!b) {
				throw new Error(
					`[LedgerMikroOrm] unable to compute account balances at timestamp=${tr.timestamp.toString(10)}`,
				)
			}
			return b
		})
	}

	private async queryAccountsDb(filter: QueryFilter): Promise<Account[]> {
		const t = await this.ensureTables()
		const em = (await this.mikro.sqlEm()) as unknown as SqlEntityManager

		const reversed = hasFlag(filter.flags, QueryFilterFlags.reversed)
		const limit = Math.max(0, Math.floor(filter.limit ?? 0))
		if (limit === 0) return []

		const where: string[] = []
		const params: unknown[] = []

		if (filter.code !== 0) {
			where.push('code = ?')
			params.push(filter.code)
		}
		if (filter.ledger !== 0) {
			where.push('ledger = ?')
			params.push(filter.ledger)
		}
		if (filter.user_data_128 !== 0n) {
			where.push('user_data_128 = ?')
			params.push(u128ToDb(filter.user_data_128))
		}
		if (filter.user_data_64 !== 0n) {
			where.push('user_data_64 = ?')
			params.push(u128ToDb(filter.user_data_64))
		}
		if (filter.user_data_32 !== 0) {
			where.push('user_data_32 = ?')
			params.push(filter.user_data_32)
		}

		const min = unboundedMin(filter.timestamp_min)
		if (min) {
			where.push('timestamp >= ?')
			params.push(min)
		}
		const max = unboundedMax(filter.timestamp_max)
		if (max) {
			where.push('timestamp <= ?')
			params.push(max)
		}

		const sql = `SELECT * FROM ${quoteIdent(t.accounts)}
			${where.length ? `WHERE ${where.join(' AND ')}` : ''}
			ORDER BY timestamp ${reversed ? 'DESC' : 'ASC'}
			LIMIT ${limit}`
		const rows = resultRows<AccountRow>(await em.execute(sql, params, 'all'))
		return rows.map(mapAccountRow)
	}

	private async queryTransfersDb(filter: QueryFilter): Promise<Transfer[]> {
		const t = await this.ensureTables()
		const em = (await this.mikro.sqlEm()) as unknown as SqlEntityManager

		const reversed = hasFlag(filter.flags, QueryFilterFlags.reversed)
		const limit = Math.max(0, Math.floor(filter.limit ?? 0))
		if (limit === 0) return []

		const where: string[] = []
		const params: unknown[] = []

		if (filter.code !== 0) {
			where.push('code = ?')
			params.push(filter.code)
		}
		if (filter.ledger !== 0) {
			where.push('ledger = ?')
			params.push(filter.ledger)
		}
		if (filter.user_data_128 !== 0n) {
			where.push('user_data_128 = ?')
			params.push(u128ToDb(filter.user_data_128))
		}
		if (filter.user_data_64 !== 0n) {
			where.push('user_data_64 = ?')
			params.push(u128ToDb(filter.user_data_64))
		}
		if (filter.user_data_32 !== 0) {
			where.push('user_data_32 = ?')
			params.push(filter.user_data_32)
		}

		const min = unboundedMin(filter.timestamp_min)
		if (min) {
			where.push('timestamp >= ?')
			params.push(min)
		}
		const max = unboundedMax(filter.timestamp_max)
		if (max) {
			where.push('timestamp <= ?')
			params.push(max)
		}

		const sql = `SELECT * FROM ${quoteIdent(t.transfers)}
			${where.length ? `WHERE ${where.join(' AND ')}` : ''}
			ORDER BY timestamp ${reversed ? 'DESC' : 'ASC'}
			LIMIT ${limit}`
		const rows = resultRows<TransferRow>(await em.execute(sql, params, 'all'))
		return rows.map(mapTransferRow)
	}

	private async createAccountsDb(batch: Account[]): Promise<CreateAccountsError[]> {
		const t = await this.ensureTables()
		const rootEm = (await this.mikro.sqlEm()) as unknown as SqlEntityManager

		return await rootEm.transactional(async (em) => {
			const ts = await this.createTimestampAllocator(em, t, batch.length)
			const errors: CreateAccountsError[] = []

			try {
				const segments = splitLinkedSegments(batch, (a) => hasFlag(a.flags, AccountFlags.linked))
				let segIndex = 0
				for (const seg of segments) {
					if (seg.open) {
						for (let i = seg.start; i < seg.end; i += 1) {
							errors.push({
								index: i,
								result:
									i === seg.end - 1
										? CreateAccountError.linked_event_chain_open
										: CreateAccountError.linked_event_failed,
							})
						}
						continue
					}

					const sp = `debit_accounts_chain_${segIndex++}`
					const checkpoint = ts.checkpoint()
					await em.execute(`SAVEPOINT ${sp}`, [], 'run')

					let failedAt: { index: number; result: CreateAccountError } | undefined
					for (let i = seg.start; i < seg.end; i += 1) {
						const r = await this.applyCreateAccount(em, t, batch[i]!, ts)
						if (r !== CreateAccountError.ok) {
							failedAt = { index: i, result: r }
							break
						}
					}

					if (!failedAt) {
						await em.execute(`RELEASE SAVEPOINT ${sp}`, [], 'run')
						continue
					}

					ts.restore(checkpoint)
					await em.execute(`ROLLBACK TO SAVEPOINT ${sp}`, [], 'run')
					await em.execute(`RELEASE SAVEPOINT ${sp}`, [], 'run')
					for (let i = seg.start; i < seg.end; i += 1) {
						errors.push({
							index: i,
							result:
								i === failedAt.index ? failedAt.result : CreateAccountError.linked_event_failed,
						})
					}
				}

				return errors
			} finally {
				await ts.flush()
			}
		})
	}

	private async createTransfersDb(batch: Transfer[]): Promise<CreateTransfersError[]> {
		const t = await this.ensureTables()
		const rootEm = (await this.mikro.sqlEm()) as unknown as SqlEntityManager

		return await rootEm.transactional(async (em) => {
			const errors: CreateTransfersError[] = []
			const failedIds = new Set<string>()

			try {
				const nowMs = Date.now()
				const expired = await this.listExpiredPendingIds(em, t, nowMs)
				const ts = await this.createTimestampAllocator(em, t, batch.length + expired.length)
				await this.expirePendingIds(em, t, expired, nowMs, ts)

				const segments = splitLinkedSegments(batch, (tr) => hasFlag(tr.flags, TransferFlags.linked))
				let segIndex = 0
				for (const seg of segments) {
					if (seg.open) {
						for (let i = seg.start; i < seg.end; i += 1) {
							failedIds.add(u128ToDb(batch[i]!.id))
							errors.push({
								index: i,
								result:
									i === seg.end - 1
										? CreateTransferError.linked_event_chain_open
										: CreateTransferError.linked_event_failed,
							})
						}
						continue
					}

					const sp = `debit_transfers_chain_${segIndex++}`
					const checkpoint = ts.checkpoint()
					await em.execute(`SAVEPOINT ${sp}`, [], 'run')

					let failedAt: { index: number; result: CreateTransferError } | undefined
					for (let i = seg.start; i < seg.end; i += 1) {
						const idDb = u128ToDb(batch[i]!.id)
						if (failedIds.has(idDb)) {
							failedAt = { index: i, result: CreateTransferError.id_already_failed }
							break
						}
						const r = await this.applyCreateTransfer(em, t, batch[i]!, nowMs, ts)
						if (r !== CreateTransferError.ok) {
							failedAt = { index: i, result: r }
							break
						}
					}

					if (!failedAt) {
						await em.execute(`RELEASE SAVEPOINT ${sp}`, [], 'run')
						continue
					}

					ts.restore(checkpoint)
					await em.execute(`ROLLBACK TO SAVEPOINT ${sp}`, [], 'run')
					await em.execute(`RELEASE SAVEPOINT ${sp}`, [], 'run')
					for (let i = seg.start; i < seg.end; i += 1) {
						failedIds.add(u128ToDb(batch[i]!.id))
					}
					for (let i = seg.start; i < seg.end; i += 1) {
						errors.push({
							index: i,
							result:
								i === failedAt.index ? failedAt.result : CreateTransferError.linked_event_failed,
						})
					}
				}

				return errors
			} finally {
				// keep signature symmetry with createAccountsDb
			}
		})
	}

	private async applyCreateAccount(
		em: SqlEntityManager,
		t: Tables,
		a: Account,
		ts: TimestampAllocator,
	): Promise<CreateAccountError> {
		if (hasFlag(a.flags, AccountFlags.imported))
			return CreateAccountError.imported_event_not_expected
		if ((a.flags & ~SUPPORTED_ACCOUNT_FLAGS) !== 0) return CreateAccountError.reserved_flag
		if (a.id === 0n) return CreateAccountError.id_must_not_be_zero
		if (isU128Max(a.id)) return CreateAccountError.id_must_not_be_int_max
		if (a.timestamp !== 0n) return CreateAccountError.timestamp_must_be_zero
		if (a.reserved !== 0) return CreateAccountError.reserved_field
		if (a.ledger === 0) return CreateAccountError.ledger_must_not_be_zero
		if (a.code === 0) return CreateAccountError.code_must_not_be_zero
		if (a.debits_pending !== 0n) return CreateAccountError.debits_pending_must_be_zero
		if (a.debits_posted !== 0n) return CreateAccountError.debits_posted_must_be_zero
		if (a.credits_pending !== 0n) return CreateAccountError.credits_pending_must_be_zero
		if (a.credits_posted !== 0n) return CreateAccountError.credits_posted_must_be_zero

		const existing = await this.loadAccount(em, t, a.id)
		if (existing) {
			const flags = stripLinkedAccountFlags(a.flags)
			if (existing.flags !== flags) return CreateAccountError.exists_with_different_flags
			if (existing.user_data_128 !== a.user_data_128)
				return CreateAccountError.exists_with_different_user_data_128
			if (existing.user_data_64 !== a.user_data_64)
				return CreateAccountError.exists_with_different_user_data_64
			if (existing.user_data_32 !== a.user_data_32)
				return CreateAccountError.exists_with_different_user_data_32
			if (existing.ledger !== a.ledger) return CreateAccountError.exists_with_different_ledger
			if (existing.code !== a.code) return CreateAccountError.exists_with_different_code
			return CreateAccountError.exists
		}

		const createdTs = ts.next()
		await em.execute(
			`INSERT INTO ${quoteIdent(t.accounts)} (id, ledger, code, flags, timestamp, debits_pending, debits_posted, credits_pending, credits_posted, user_data_128, user_data_64, user_data_32, reserved)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				u128ToDb(a.id),
				a.ledger,
				a.code,
				stripLinkedAccountFlags(a.flags),
				createdTs,
				u128ToDb(0n),
				u128ToDb(0n),
				u128ToDb(0n),
				u128ToDb(0n),
				u128ToDb(a.user_data_128),
				u128ToDb(a.user_data_64),
				a.user_data_32,
				0,
			],
			'run',
		)

		return CreateAccountError.ok
	}

	private async applyCreateTransfer(
		em: SqlEntityManager,
		t: Tables,
		tr: Transfer,
		nowMs: number,
		ts: TimestampAllocator,
	): Promise<CreateTransferError> {
		if (hasFlag(tr.flags, TransferFlags.imported))
			return CreateTransferError.imported_event_not_expected
		if ((tr.flags & ~SUPPORTED_TRANSFER_FLAGS) !== 0) return CreateTransferError.reserved_flag
		if (tr.id === 0n) return CreateTransferError.id_must_not_be_zero
		if (isU128Max(tr.id)) return CreateTransferError.id_must_not_be_int_max
		if (isU128Max(tr.debit_account_id))
			return CreateTransferError.debit_account_id_must_not_be_int_max
		if (isU128Max(tr.credit_account_id))
			return CreateTransferError.credit_account_id_must_not_be_int_max
		if (isU128Max(tr.pending_id)) return CreateTransferError.pending_id_must_not_be_int_max
		if (tr.timestamp !== 0n) return CreateTransferError.timestamp_must_be_zero
		if (!hasFlag(tr.flags, TransferFlags.pending) && tr.timeout !== 0)
			return CreateTransferError.timeout_reserved_for_pending_transfer

		const existing = await this.loadTransfer(em, t, tr.id)
		if (existing) {
			const desiredFlags = stripLinkedTransferFlags(tr.flags)
			if (existing.flags !== desiredFlags) return CreateTransferError.exists_with_different_flags

			// post/void allow inheriting (0) for some fields. Normalize to the existing row for
			// idempotency comparisons to match TigerBeetle's "same request shape" semantics.
			const isPost = hasFlag(desiredFlags, TransferFlags.post_pending_transfer)
			const isVoid = hasFlag(desiredFlags, TransferFlags.void_pending_transfer)
			const allowInherit = isPost || isVoid

			const debitAccountId =
				allowInherit && tr.debit_account_id === 0n ? existing.debit_account_id : tr.debit_account_id
			const creditAccountId =
				allowInherit && tr.credit_account_id === 0n
					? existing.credit_account_id
					: tr.credit_account_id
			const ledger = allowInherit && tr.ledger === 0 ? existing.ledger : tr.ledger
			const code = allowInherit && tr.code === 0 ? existing.code : tr.code

			let amount = tr.amount
			if (isPost && tr.amount === amount_max) amount = existing.amount
			if (isVoid && tr.amount === 0n) amount = existing.amount

			if (existing.debit_account_id !== debitAccountId)
				return CreateTransferError.exists_with_different_debit_account_id
			if (existing.credit_account_id !== creditAccountId)
				return CreateTransferError.exists_with_different_credit_account_id
			if (existing.amount !== amount) return CreateTransferError.exists_with_different_amount
			if (existing.pending_id !== tr.pending_id)
				return CreateTransferError.exists_with_different_pending_id

			if (existing.user_data_128 !== tr.user_data_128)
				return CreateTransferError.exists_with_different_user_data_128
			if (existing.user_data_64 !== tr.user_data_64)
				return CreateTransferError.exists_with_different_user_data_64
			if (existing.user_data_32 !== tr.user_data_32)
				return CreateTransferError.exists_with_different_user_data_32

			if (existing.timeout !== tr.timeout) return CreateTransferError.exists_with_different_timeout
			if (existing.ledger !== ledger) return CreateTransferError.exists_with_different_ledger
			if (existing.code !== code) return CreateTransferError.exists_with_different_code

			return CreateTransferError.exists
		}

		const flags = tr.flags
		const isPending = hasFlag(flags, TransferFlags.pending)
		const isPost = hasFlag(flags, TransferFlags.post_pending_transfer)
		const isVoid = hasFlag(flags, TransferFlags.void_pending_transfer)

		if ((isPending && (isPost || isVoid)) || (isPost && isVoid)) {
			return CreateTransferError.flags_are_mutually_exclusive
		}

		if (isPost || isVoid) {
			return await this.applyResolvePending(em, t, tr, isPost ? 'post' : 'void', nowMs, ts)
		}

		return isPending
			? await this.applyPendingTransfer(em, t, tr, nowMs, ts)
			: await this.applyPostedTransfer(em, t, tr, ts)
	}

	private async applyPostedTransfer(
		em: SqlEntityManager,
		t: Tables,
		tr: Transfer,
		ts: TimestampAllocator,
	): Promise<CreateTransferError> {
		if (tr.debit_account_id === 0n) return CreateTransferError.debit_account_id_must_not_be_zero
		if (tr.credit_account_id === 0n) return CreateTransferError.credit_account_id_must_not_be_zero
		if (tr.debit_account_id === tr.credit_account_id)
			return CreateTransferError.accounts_must_be_different
		if (tr.pending_id !== 0n) return CreateTransferError.pending_id_must_be_zero
		if (tr.ledger === 0) return CreateTransferError.ledger_must_not_be_zero
		if (tr.code === 0) return CreateTransferError.code_must_not_be_zero

		const debit = await this.loadAccount(em, t, tr.debit_account_id)
		if (!debit) return CreateTransferError.debit_account_not_found
		const credit = await this.loadAccount(em, t, tr.credit_account_id)
		if (!credit) return CreateTransferError.credit_account_not_found

		if (debit.ledger !== credit.ledger)
			return CreateTransferError.accounts_must_have_the_same_ledger
		if (tr.ledger !== debit.ledger)
			return CreateTransferError.transfer_must_have_the_same_ledger_as_accounts

		const constraint = this.checkAccountConstraints(debit, credit, tr.amount)
		if (constraint !== CreateTransferError.ok) return constraint

		debit.debits_posted += tr.amount
		credit.credits_posted += tr.amount
		await this.updateAccountBalances(em, t, debit)
		await this.updateAccountBalances(em, t, credit)

		const createdTs = ts.next()
		await em.execute(
			`INSERT INTO ${quoteIdent(t.transfers)} (id, debit_account_id, credit_account_id, amount, pending_id, user_data_128, user_data_64, user_data_32, timeout, ledger, code, flags, timestamp)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				u128ToDb(tr.id),
				u128ToDb(tr.debit_account_id),
				u128ToDb(tr.credit_account_id),
				u128ToDb(tr.amount),
				u128ToDb(0n),
				u128ToDb(tr.user_data_128),
				u128ToDb(tr.user_data_64),
				tr.user_data_32,
				tr.timeout,
				tr.ledger,
				tr.code,
				stripLinkedTransferFlags(tr.flags),
				createdTs,
			],
			'run',
		)

		return CreateTransferError.ok
	}

	private async applyPendingTransfer(
		em: SqlEntityManager,
		t: Tables,
		tr: Transfer,
		nowMs: number,
		ts: TimestampAllocator,
	): Promise<CreateTransferError> {
		if (tr.debit_account_id === 0n) return CreateTransferError.debit_account_id_must_not_be_zero
		if (tr.credit_account_id === 0n) return CreateTransferError.credit_account_id_must_not_be_zero
		if (tr.debit_account_id === tr.credit_account_id)
			return CreateTransferError.accounts_must_be_different
		if (tr.pending_id !== 0n) return CreateTransferError.pending_id_must_be_zero
		if (tr.ledger === 0) return CreateTransferError.ledger_must_not_be_zero
		if (tr.code === 0) return CreateTransferError.code_must_not_be_zero

		const debit = await this.loadAccount(em, t, tr.debit_account_id)
		if (!debit) return CreateTransferError.debit_account_not_found
		const credit = await this.loadAccount(em, t, tr.credit_account_id)
		if (!credit) return CreateTransferError.credit_account_not_found

		if (debit.ledger !== credit.ledger)
			return CreateTransferError.accounts_must_have_the_same_ledger
		if (tr.ledger !== debit.ledger)
			return CreateTransferError.transfer_must_have_the_same_ledger_as_accounts

		const constraint = this.checkAccountConstraints(debit, credit, tr.amount)
		if (constraint !== CreateTransferError.ok) return constraint

		debit.debits_pending += tr.amount
		credit.credits_pending += tr.amount
		await this.updateAccountBalances(em, t, debit)
		await this.updateAccountBalances(em, t, credit)

		const createdTs = ts.next()
		await em.execute(
			`INSERT INTO ${quoteIdent(t.transfers)} (id, debit_account_id, credit_account_id, amount, pending_id, user_data_128, user_data_64, user_data_32, timeout, ledger, code, flags, timestamp)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				u128ToDb(tr.id),
				u128ToDb(tr.debit_account_id),
				u128ToDb(tr.credit_account_id),
				u128ToDb(tr.amount),
				u128ToDb(0n),
				u128ToDb(tr.user_data_128),
				u128ToDb(tr.user_data_64),
				tr.user_data_32,
				tr.timeout,
				tr.ledger,
				tr.code,
				stripLinkedTransferFlags(tr.flags),
				createdTs,
			],
			'run',
		)

		const expiresAtMs = tr.timeout > 0 ? nowMs + Math.max(1, Math.floor(tr.timeout)) * 1000 : null
		await em.execute(
			`INSERT INTO ${quoteIdent(t.pending)} (pending_id, resolution, resolution_transfer_id, resolved_timestamp, posted_amount, expires_at_ms)
			 VALUES (?, NULL, NULL, NULL, NULL, ?)`,
			[u128ToDb(tr.id), expiresAtMs],
			'run',
		)

		return CreateTransferError.ok
	}

	private async applyResolvePending(
		em: SqlEntityManager,
		t: Tables,
		tr: Transfer,
		mode: 'post' | 'void',
		nowMs: number,
		ts: TimestampAllocator,
	): Promise<CreateTransferError> {
		if (tr.pending_id === 0n) return CreateTransferError.pending_id_must_not_be_zero
		if (tr.pending_id === tr.id) return CreateTransferError.pending_id_must_be_different

		const pending = await this.loadTransfer(em, t, tr.pending_id)
		if (!pending) return CreateTransferError.pending_transfer_not_found
		if (!hasFlag(pending.flags, TransferFlags.pending))
			return CreateTransferError.pending_transfer_not_pending

		const pendingState = await this.loadPendingState(em, t, tr.pending_id)
		if (pendingState) {
			if (pendingState.resolution === 'posted')
				return CreateTransferError.pending_transfer_already_posted
			if (pendingState.resolution === 'voided')
				return CreateTransferError.pending_transfer_already_voided
			if (pendingState.resolution === 'expired') return CreateTransferError.pending_transfer_expired
			if (pendingState.expires_at_ms != null && pendingState.expires_at_ms <= nowMs) {
				await this.expireOnePending(em, t, pending, pendingState, ts)
				return CreateTransferError.pending_transfer_expired
			}
		}

		const effectiveDebit =
			tr.debit_account_id === 0n ? pending.debit_account_id : tr.debit_account_id
		if (effectiveDebit !== pending.debit_account_id)
			return CreateTransferError.pending_transfer_has_different_debit_account_id

		const effectiveCredit =
			tr.credit_account_id === 0n ? pending.credit_account_id : tr.credit_account_id
		if (effectiveCredit !== pending.credit_account_id)
			return CreateTransferError.pending_transfer_has_different_credit_account_id

		const effectiveLedger = tr.ledger === 0 ? pending.ledger : tr.ledger
		if (effectiveLedger !== pending.ledger)
			return CreateTransferError.pending_transfer_has_different_ledger

		const effectiveCode = tr.code === 0 ? pending.code : tr.code
		if (effectiveCode !== pending.code)
			return CreateTransferError.pending_transfer_has_different_code

		let effectiveAmount: bigint
		if (mode === 'post') {
			if (tr.amount === amount_max) {
				effectiveAmount = pending.amount
			} else if (tr.amount <= pending.amount) {
				effectiveAmount = tr.amount
			} else {
				return CreateTransferError.exceeds_pending_transfer_amount
			}
		} else {
			const requested = tr.amount === 0n ? pending.amount : tr.amount
			if (requested !== pending.amount)
				return CreateTransferError.pending_transfer_has_different_amount
			effectiveAmount = requested
		}

		const debit = await this.loadAccount(em, t, pending.debit_account_id)
		if (!debit) return CreateTransferError.debit_account_not_found
		const credit = await this.loadAccount(em, t, pending.credit_account_id)
		if (!credit) return CreateTransferError.credit_account_not_found

		// Release full pending amount.
		debit.debits_pending -= pending.amount
		credit.credits_pending -= pending.amount

		// Apply posted amount (post only).
		if (mode === 'post') {
			const constraint = this.checkAccountConstraints(debit, credit, effectiveAmount)
			if (constraint !== CreateTransferError.ok) return constraint
			debit.debits_posted += effectiveAmount
			credit.credits_posted += effectiveAmount
		}

		await this.updateAccountBalances(em, t, debit)
		await this.updateAccountBalances(em, t, credit)

		const createdTs = ts.next()
		await em.execute(
			`INSERT INTO ${quoteIdent(t.transfers)} (id, debit_account_id, credit_account_id, amount, pending_id, user_data_128, user_data_64, user_data_32, timeout, ledger, code, flags, timestamp)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				u128ToDb(tr.id),
				u128ToDb(effectiveDebit),
				u128ToDb(effectiveCredit),
				u128ToDb(effectiveAmount),
				u128ToDb(tr.pending_id),
				u128ToDb(tr.user_data_128),
				u128ToDb(tr.user_data_64),
				tr.user_data_32,
				tr.timeout,
				effectiveLedger,
				effectiveCode,
				stripLinkedTransferFlags(tr.flags),
				createdTs,
			],
			'run',
		)

		const resolution = mode === 'post' ? 'posted' : 'voided'
		await em.execute(
			`UPDATE ${quoteIdent(t.pending)}
			 SET resolution = ?, resolution_transfer_id = ?, resolved_timestamp = ?, posted_amount = ?
			 WHERE pending_id = ?`,
			[
				resolution,
				u128ToDb(tr.id),
				createdTs,
				mode === 'post' ? u128ToDb(effectiveAmount) : null,
				u128ToDb(tr.pending_id),
			],
			'run',
		)

		return CreateTransferError.ok
	}

	private async listExpiredPendingIds(
		em: SqlEntityManager,
		t: Tables,
		nowMs: number,
	): Promise<string[]> {
		const rows = resultRows<{ pending_id: string }>(
			await em.execute(
				`SELECT pending_id FROM ${quoteIdent(t.pending)}
				 WHERE resolution IS NULL AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?`,
				[nowMs],
				'all',
			),
		)
		return rows.map((r) => r.pending_id)
	}

	private async expirePendingIds(
		em: SqlEntityManager,
		t: Tables,
		pendingIds: string[],
		nowMs: number,
		ts: TimestampAllocator,
	): Promise<void> {
		for (const pendingId of pendingIds) {
			const pending = await this.loadTransferById(em, t, pendingId)
			if (!pending) continue
			if (!hasFlag(pending.flags, TransferFlags.pending)) continue

			const state = await this.loadPendingStateById(em, t, pendingId)
			if (!state || state.resolution != null) continue
			// Safety: the selection query was `expires_at_ms <= nowMs` but we may have stale clocks.
			if (state.expires_at_ms != null && state.expires_at_ms > nowMs) continue

			await this.expireOnePending(em, t, pending, state, ts)
		}
	}

	private async expireOnePending(
		em: SqlEntityManager,
		t: Tables,
		pending: Transfer,
		state: PendingRow,
		ts: TimestampAllocator,
	): Promise<void> {
		const debit = await this.loadAccount(em, t, pending.debit_account_id)
		const credit = await this.loadAccount(em, t, pending.credit_account_id)
		if (!debit || !credit) return

		debit.debits_pending -= pending.amount
		credit.credits_pending -= pending.amount
		await this.updateAccountBalances(em, t, debit)
		await this.updateAccountBalances(em, t, credit)

		const resolvedTs = ts.next()
		await em.execute(
			`UPDATE ${quoteIdent(t.pending)}
			 SET resolution = ?, resolved_timestamp = ?, resolution_transfer_id = NULL, posted_amount = NULL
			 WHERE pending_id = ?`,
			['expired', resolvedTs, state.pending_id],
			'run',
		)
	}

	private async createTimestampAllocator(
		em: SqlEntityManager,
		t: Tables,
		reserveCount: number,
	): Promise<TimestampAllocator> {
		const key = 'clock'

		const reserve = Math.max(0, Math.floor(reserveCount))
		if (reserve === 0) {
			let cur = 0n
			return {
				next: () => {
					cur += 1n
					return formatTs(cur)
				},
				checkpoint: () => cur,
				restore: (checkpoint) => {
					cur = checkpoint
				},
				flush: async () => {
					// no-op (nothing reserved/persisted)
				},
			}
		}

		// Ensure the clock row exists, then reserve a monotonic range in one atomic update.
		await em.execute(
			`INSERT OR IGNORE INTO ${quoteIdent(t.clock)} (key, last_timestamp) VALUES (?, ?)`,
			[key, formatTs(0n)],
			'run',
		)
		const reserved = resultRows<Record<string, unknown>>(
			await em.execute(
				`UPDATE ${quoteIdent(t.clock)}
				 SET last_timestamp = printf('%0${TS_WIDTH}d', CAST(last_timestamp AS INTEGER) + ?)
				 WHERE key = ?
				 RETURNING last_timestamp`,
				[reserve, key],
				'all',
			),
		)[0]
		if (!reserved) throw new Error('[LedgerMikroOrm] failed to reserve timestamps')

		const end = BigInt(requiredString(reserved, 'last_timestamp'))
		const start = end - BigInt(reserve) + 1n
		let cursor = start - 1n

		return {
			next: () => {
				cursor += 1n
				return formatTs(cursor)
			},
			checkpoint: () => cursor,
			restore: (checkpoint) => {
				cursor = checkpoint
			},
			flush: async () => {
				// no-op: timestamps are reserved upfront (clock already advanced)
			},
		}
	}

	private async loadAccount(
		em: SqlEntityManager,
		t: Tables,
		id: bigint,
	): Promise<(Account & { id_db: string }) | null> {
		return await this.loadAccountById(em, t, u128ToDb(id))
	}

	private async loadAccountById(
		em: SqlEntityManager,
		t: Tables,
		idDb: string,
	): Promise<(Account & { id_db: string }) | null> {
		const row = resultRows<Record<string, unknown>>(
			await em.execute(`SELECT * FROM ${quoteIdent(t.accounts)} WHERE id = ?`, [idDb], 'all'),
		)[0]
		if (!row) return null
		return { id_db: idDb, ...mapAccountRow(row) }
	}

	private async updateAccountBalances(
		em: SqlEntityManager,
		t: Tables,
		a: Account & { id_db?: string },
	): Promise<void> {
		const idDb = a.id_db ?? u128ToDb(a.id)
		await em.execute(
			`UPDATE ${quoteIdent(t.accounts)}
			 SET debits_pending = ?, debits_posted = ?, credits_pending = ?, credits_posted = ?, flags = ?
			 WHERE id = ?`,
			[
				u128ToDb(a.debits_pending),
				u128ToDb(a.debits_posted),
				u128ToDb(a.credits_pending),
				u128ToDb(a.credits_posted),
				stripLinkedAccountFlags(a.flags),
				idDb,
			],
			'run',
		)
	}

	private async loadTransfer(
		em: SqlEntityManager,
		t: Tables,
		id: bigint,
	): Promise<Transfer | null> {
		return await this.loadTransferById(em, t, u128ToDb(id))
	}

	private async loadTransferById(
		em: SqlEntityManager,
		t: Tables,
		idDb: string,
	): Promise<Transfer | null> {
		const row = resultRows<Record<string, unknown>>(
			await em.execute(`SELECT * FROM ${quoteIdent(t.transfers)} WHERE id = ?`, [idDb], 'all'),
		)[0]
		if (!row) return null
		return mapTransferRow(row)
	}

	private async loadPendingState(
		em: SqlEntityManager,
		t: Tables,
		pendingId: bigint,
	): Promise<PendingRow | null> {
		return await this.loadPendingStateById(em, t, u128ToDb(pendingId))
	}

	private async loadPendingStateById(
		em: SqlEntityManager,
		t: Tables,
		pendingIdDb: string,
	): Promise<PendingRow | null> {
		const row = resultRows<Record<string, unknown>>(
			await em.execute(
				`SELECT * FROM ${quoteIdent(t.pending)} WHERE pending_id = ?`,
				[pendingIdDb],
				'all',
			),
		)[0]
		if (!row) return null
		return {
			pending_id: requiredString(row, 'pending_id'),
			resolution: row.resolution == null ? null : String(row.resolution),
			resolution_transfer_id:
				row.resolution_transfer_id == null ? null : String(row.resolution_transfer_id),
			resolved_timestamp: row.resolved_timestamp == null ? null : String(row.resolved_timestamp),
			posted_amount: row.posted_amount == null ? null : String(row.posted_amount),
			expires_at_ms: row.expires_at_ms == null ? null : Number(row.expires_at_ms),
		}
	}

	private checkAccountConstraints(
		debit: Account,
		credit: Account,
		amount: bigint,
	): CreateTransferError {
		if (hasFlag(debit.flags, AccountFlags.debits_must_not_exceed_credits)) {
			const projected = debit.debits_pending + debit.debits_posted + amount
			if (projected > debit.credits_posted) return CreateTransferError.exceeds_credits
		}
		if (hasFlag(credit.flags, AccountFlags.credits_must_not_exceed_debits)) {
			const projected = credit.credits_pending + credit.credits_posted + amount
			if (projected > credit.debits_posted) return CreateTransferError.exceeds_debits
		}
		return CreateTransferError.ok
	}
}

// Bun/TS sometimes emits `design:paramtypes` as `Object` for cross-package abstract classes.
// Ensure DI always injects the correct token.
setParamToken(LedgerMikroOrm, 0, MikroOrm)
