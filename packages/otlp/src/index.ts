export type * from './core.js'
export { Otlp } from './core.js'

import { OtlpHub } from './hub.js'
export {
	OtlpHub,
	OtlpHubConfigSchemas,
	OtlpHubBatchCfgSchema,
	OtlpHubCoreCfgSchema,
	OtlpHubQueueCfgSchema,
	OtlpHubResourceCfgSchema,
	OtlpHubScopeCfgSchema,
	OtlpHubSignalsCfgSchema,
} from './hub.js'

/** Default provider plugin (OTLP/HTTP JSON logs/traces/metrics exporter). */
export { OtlpHub as default } from './hub.js'

/** Convenience export for plugin registration. */
export const plugins = [OtlpHub] as const
