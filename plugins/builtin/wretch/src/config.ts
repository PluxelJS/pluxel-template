import {
	type NormalizedWretchClientConfig,
	type NormalizedWretchPluginConfig,
	type WretchPluginClientConfig,
	type WretchPluginConfig,
} from './schema'

export function normalizeWretchConfig(cfg: WretchPluginConfig): NormalizedWretchPluginConfig {
	const defaults: NormalizedWretchClientConfig = {
		baseUrl: cfg.defaults?.baseUrl,
		headers: {
			...(cfg.defaults?.headers ?? {}),
		},
		credentials: cfg.defaults?.credentials,
		options: cfg.defaults?.options,
	}

	const clients: Record<string, NormalizedWretchClientConfig> = Object.create(null)
	clients.default = defaults

	const mergeClient = (c?: WretchPluginClientConfig): NormalizedWretchClientConfig => ({
		baseUrl: c?.baseUrl ?? defaults.baseUrl,
		headers: { ...(defaults.headers ?? {}), ...(c?.headers ?? {}) },
		credentials: c?.credentials ?? defaults.credentials,
		options: c?.options ?? defaults.options,
	})

	const configured = cfg.clients ?? {}
	for (const [name, c] of Object.entries(configured)) {
		clients[name] = mergeClient(c)
	}

	const desired = cfg.defaultClient
	const defaultClientName = desired && desired in clients ? desired : 'default'
	return { defaultClientName, clients }
}
