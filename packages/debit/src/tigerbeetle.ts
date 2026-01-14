import { Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { createClient, type Client as TigerBeetleClient } from 'tigerbeetle-node'
import { Debit, type DebitDriver } from './core.js'

export const DebitTigerBeetleConfigSchema = v.object({
	/** TigerBeetle cluster_id (u128) as decimal string. */
	clusterId: v.string(),
	/** Comma-separated replica addresses, e.g. `127.0.0.1:3000,127.0.0.1:3001`. */
	replicaAddresses: v.string(),
})

export type DebitTigerBeetleConfig = Config<typeof DebitTigerBeetleConfigSchema>

type ResolvedConfig = {
	cluster_id: bigint
	replica_addresses: string[]
}

@Plugin(Debit, { name: 'TigerBeetle', type: 'service' })
export class DebitTigerBeetle extends Debit {
	@Config(DebitTigerBeetleConfigSchema)
	private config!: DebitTigerBeetleConfig

	private resolved: ResolvedConfig | undefined
	private client: TigerBeetleClient | undefined

	protected override init(_abort: AbortSignal): void {
		// Validate early for faster feedback in dev.
		this.ensureClient()
		this.ctx.logger.info('ready')
	}

	protected createDriver(): DebitDriver {
		return this.ensureClient()
	}

	protected override async stop(abort: AbortSignal): Promise<void> {
		await super.stop(abort)
		this.client = undefined
		this.resolved = undefined
	}

	private ensureResolved(): ResolvedConfig {
		if (this.resolved) return this.resolved

		const cluster_id = parseU128Decimal(this.config.clusterId, '[DebitTigerBeetle] clusterId')
		const replica_addresses = splitCommaSeparated(this.config.replicaAddresses)
		if (replica_addresses.length === 0) {
			throw new Error('[DebitTigerBeetle] replicaAddresses must not be empty')
		}

		this.resolved = { cluster_id, replica_addresses }
		return this.resolved
	}

	private ensureClient(): TigerBeetleClient {
		if (this.client) return this.client
		const cfg = this.ensureResolved()
		this.client = createClient({
			cluster_id: cfg.cluster_id,
			replica_addresses: cfg.replica_addresses,
		})
		return this.client
	}
}

function splitCommaSeparated(raw: string): string[] {
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
}

function parseU128Decimal(raw: string, label: string): bigint {
	const s = raw.trim()
	if (!s) throw new Error(`${label} is required`)
	if (!/^[0-9]+$/.test(s)) throw new Error(`${label} must be a decimal integer string`)
	const v = BigInt(s)
	if (v <= 0n) throw new Error(`${label} must be > 0`)
	return v
}
