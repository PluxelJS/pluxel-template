import { Plugin } from '@pluxel/hmr'
import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import type { Storage } from 'unstorage'
import { Kv, type KvDriver, type KvDriverSetOptions } from './core.js'

function driverFromUnstorage(storage: Storage): KvDriver {
	return {
		hasItem: (key) => storage.hasItem(key),
		getItem: async <T = unknown>(key: string) => (await storage.getItem(key)) as T | null,
		setItem: (key, value, options?: KvDriverSetOptions) =>
			storage.setItem(key, value as any, options as any),
		removeItem: (key) => storage.removeItem(key),
		getKeys: (base) => storage.getKeys(base),
		clear: (base) => storage.clear(base),
		dispose: () => storage.dispose(),
	}
}

@Plugin(Kv, { name: 'Kv', type: 'service' })
export class KvMemory extends Kv {
	private _storage: Storage | undefined
	private _driver: KvDriver | undefined

	protected driver(): KvDriver {
		this._storage ??= createStorage({ driver: memoryDriver() })
		this._driver ??= driverFromUnstorage(this._storage)
		return this._driver
	}

	protected override async stop(_abort: AbortSignal): Promise<void> {
		await this._driver?.dispose?.()
		this._storage = undefined
		this._driver = undefined
	}
}
