export type * from './core.js'
export { Otlp } from './core.js'

import { OtlpHub } from './hub.js'
export type { OtlpTap, OtlpTapMeta } from './tap.js'
export {
	OtlpHubExportingCfgSchema,
	OtlpHubPushCfgSchema,
	OtlpHubRoutingCfgSchemaV2,
	OtlpHubBatchCfgSchema,
	OtlpHubSignalEndpointsCfgSchema,
	OtlpHubTargetCfgSchema,
	OtlpHubRoutingCfgSchema,
	OtlpHubQueueCfgSchema,
	OtlpHubResourceCfgSchema,
	OtlpHubScopeCfgSchema,
	OtlpHubSignalsCfgSchema,
	DEFAULT_BATCH,
	DEFAULT_PUSH,
	DEFAULT_QUEUE,
	DEFAULT_RESOURCE,
	DEFAULT_ROUTING,
	DEFAULT_SCOPE,
	DEFAULT_SIGNALS,
	DEFAULT_SIGNAL_ENDPOINTS,
	normalizeEndpoint,
} from './config.js'
export {
	OtlpHub,
} from './hub.js'

/** Default provider plugin (OTLP/HTTP JSON logs/traces/metrics exporter). */
export { OtlpHub as default } from './hub.js'

/** Convenience export for plugin registration. */
export const plugins = [OtlpHub] as const
