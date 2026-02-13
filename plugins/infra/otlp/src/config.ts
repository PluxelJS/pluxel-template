import { f, v } from '@pluxel/hmr/config'

export const DEFAULT_SIGNAL_ENDPOINTS = Object.freeze({ logs: '', traces: '', metrics: '' })

const SECTION_EXPORTING = {
	id: 'exporting',
	title: 'Exporting',
	description: 'Choose how OtlpHub exports telemetry (or capture-only).',
} as const

const SECTION_ROUTING = {
	id: 'routing',
	title: 'Routing',
	description: 'Optional multi-destination routing for OTLP push.',
} as const

export const OtlpHubSignalEndpointsCfgSchema = v.object({
	logs: v.optional(v.string(), ''),
	traces: v.optional(v.string(), ''),
	metrics: v.optional(v.string(), ''),
})

export const OtlpHubTargetCfgSchema = v.object({
	id: v.pipe(
		v.string(),
		v.minLength(1),
		f.formMeta({ label: 'Target ID', description: 'Used by routing.byCallerId/byCallerName.' }),
	),
	endpoint: v.pipe(
		v.string(),
		v.minLength(1),
		f.formMeta({ label: 'Endpoint', description: 'Collector base URL (e.g. http://localhost:4318).' }),
	),
	endpoints: v.optional(OtlpHubSignalEndpointsCfgSchema, DEFAULT_SIGNAL_ENDPOINTS),
	headers: v.optional(v.record(v.string(), v.string()), {}),
	timeoutMs: v.optional(v.number(), 10_000),
})

export const OtlpHubRoutingCfgSchema = v.object({
	defaultTargetId: v.pipe(
		v.optional(v.string(), ''),
		f.formMeta({ label: 'Default target', description: 'Fallback routing target id (empty = default).' }),
	),
	byCallerId: v.pipe(
		v.optional(v.record(v.string(), v.string()), {}),
		f.formMeta({ label: 'By caller id', description: 'Map caller plugin id -> target id.' }),
	),
	byCallerName: v.pipe(
		v.optional(v.record(v.string(), v.string()), {}),
		f.formMeta({ label: 'By caller name', description: 'Map caller displayName -> target id.' }),
	),
})

export const OtlpHubSignalsCfgSchema = v.object({
	logs: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '启用 Logs', description: 'OTLP /v1/logs' }),
		f.booleanMeta({}),
	),
	traces: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '启用 Traces', description: 'OTLP /v1/traces' }),
		f.booleanMeta({}),
	),
	metrics: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '启用 Metrics', description: 'OTLP /v1/metrics' }),
		f.booleanMeta({}),
	),
})

export const OtlpHubResourceCfgSchema = v.object({
	serviceName: v.optional(v.string(), 'pluxel'),
	serviceNamespace: v.optional(v.string(), ''),
	serviceVersion: v.optional(v.string(), ''),
	resourceAttributes: v.optional(v.record(v.string(), v.any()), {}),
})

export const OtlpHubScopeCfgSchema = v.object({
	name: v.optional(v.string(), 'pluxel'),
	version: v.optional(v.string(), ''),
})

export const OtlpHubBatchCfgSchema = v.object({
	flushIntervalMs: v.optional(v.number(), 1000),
	maxBatchRecords: v.optional(v.number(), 256),
	maxBatchBytes: v.optional(v.number(), 256 * 1024),
	maxInflight: v.optional(v.number(), 1),
})

export const OtlpHubQueueCfgSchema = v.object({
	maxQueuedRecords: v.optional(v.number(), 5000),
	maxQueuedBytes: v.optional(v.number(), 2 * 1024 * 1024),
	overflow: v.optional(v.picklist(['dropNewest', 'dropOldest', 'block'] as const), 'dropNewest'),
})

export type OtlpHubBatchConfig = v.InferOutput<typeof OtlpHubBatchCfgSchema>
export type OtlpHubQueueConfig = v.InferOutput<typeof OtlpHubQueueCfgSchema>
export type OtlpHubSignalsConfig = v.InferOutput<typeof OtlpHubSignalsCfgSchema>
export type OtlpHubTargetConfig = v.InferOutput<typeof OtlpHubTargetCfgSchema>
export type OtlpHubRoutingConfig = v.InferOutput<typeof OtlpHubRoutingCfgSchema>
export type OtlpHubSignalEndpointsConfig = v.InferOutput<typeof OtlpHubSignalEndpointsCfgSchema>
export type OtlpHubResourceConfig = v.InferOutput<typeof OtlpHubResourceCfgSchema>
export type OtlpHubScopeConfig = v.InferOutput<typeof OtlpHubScopeCfgSchema>

export const DEFAULT_SIGNALS: OtlpHubSignalsConfig = Object.freeze({ logs: false, traces: true, metrics: true })
export const DEFAULT_ROUTING: OtlpHubRoutingConfig = Object.freeze({ defaultTargetId: '', byCallerId: {}, byCallerName: {} })
export const DEFAULT_RESOURCE: OtlpHubResourceConfig = Object.freeze({
	serviceName: 'pluxel',
	serviceNamespace: '',
	serviceVersion: '',
	resourceAttributes: {},
})
export const DEFAULT_SCOPE: OtlpHubScopeConfig = Object.freeze({ name: 'pluxel', version: '' })
export const DEFAULT_BATCH: OtlpHubBatchConfig = Object.freeze({
	flushIntervalMs: 1000,
	maxBatchRecords: 256,
	maxBatchBytes: 256 * 1024,
	maxInflight: 1,
})
export const DEFAULT_QUEUE: OtlpHubQueueConfig = Object.freeze({
	maxQueuedRecords: 5000,
	maxQueuedBytes: 2 * 1024 * 1024,
	overflow: 'dropNewest',
})

export const DEFAULT_PUSH = Object.freeze({
	endpoint: 'http://localhost:4318',
	endpoints: DEFAULT_SIGNAL_ENDPOINTS,
	headers: {},
	timeoutMs: 10_000,
})

export const OtlpHubPushCfgSchema = v.object({
	endpoint: v.pipe(
		v.optional(v.pipe(v.string(), v.minLength(1)), 'http://localhost:4318'),
		f.formMeta({ label: 'Endpoint (fallback)', description: 'Fallback base URL (used when a signal base is missing).', section: SECTION_EXPORTING }),
	),
	endpoints: v.pipe(
		v.optional(OtlpHubSignalEndpointsCfgSchema, DEFAULT_SIGNAL_ENDPOINTS),
		f.formMeta({ label: 'Per-signal bases', description: 'Override base URL per signal (base only; plugin appends /v1/*).', section: SECTION_EXPORTING }),
	),
	headers: v.pipe(
		v.optional(v.record(v.string(), v.string()), {}),
		f.formMeta({ label: 'Headers', description: 'Extra headers for OTLP/HTTP requests.', section: SECTION_EXPORTING }),
	),
	timeoutMs: v.pipe(
		v.optional(v.number(), 10_000),
		f.formMeta({ label: 'Timeout (ms)', section: SECTION_EXPORTING }),
		f.numberMeta({ min: 1, step: 1 }),
	),
})

export type OtlpHubPushConfig = v.InferOutput<typeof OtlpHubPushCfgSchema>

export const OtlpHubExportingCfgSchema = v.object({
	mode: v.pipe(
		v.optional(v.picklist(['tap', 'push'] as const), 'tap'),
		f.formMeta({ label: 'Mode', description: 'Exporting mode. tap = local capture only; push = OTLP/HTTP JSON.', section: SECTION_EXPORTING }),
		f.picklistMeta({
			control: 'segmented',
			labels: { tap: 'Tap only', push: 'Push' },
		}),
	),
	push: v.pipe(
		v.optional(OtlpHubPushCfgSchema, DEFAULT_PUSH),
		f.formMeta({ label: 'Push', description: 'OTLP/HTTP base URLs + headers (used when mode=push).', section: SECTION_EXPORTING }),
		f.objectMeta({ collapsible: true, collapsed: true }),
	),
})

export type OtlpHubExportingConfig = v.InferOutput<typeof OtlpHubExportingCfgSchema>

export const OtlpHubRoutingCfgSchemaV2 = v.object({
	mode: v.pipe(
		v.optional(v.picklist(['single', 'multi'] as const), 'single'),
		f.formMeta({ label: 'Mode', description: 'Routing mode. multi enables per-caller routing.', section: SECTION_ROUTING }),
		f.picklistMeta({
			control: 'segmented',
			labels: { single: 'Single', multi: 'Multi' },
		}),
	),
	targets: v.pipe(
		v.optional(v.array(OtlpHubTargetCfgSchema), []),
		f.formMeta({ label: 'Targets', description: 'Additional OTLP destinations for routing (used when mode=multi).', section: SECTION_ROUTING }),
		f.arrayMeta({ layout: 'list' }),
	),
	routing: v.pipe(
		v.optional(OtlpHubRoutingCfgSchema, DEFAULT_ROUTING),
		f.formMeta({ label: 'Routing', description: 'Map caller plugin id/name to a target id (used when mode=multi).', section: SECTION_ROUTING }),
		f.objectMeta({ collapsible: true, collapsed: true }),
	),
})

export type OtlpHubRoutingConfigV2 = v.InferOutput<typeof OtlpHubRoutingCfgSchemaV2>

export function normalizeEndpoint(raw: string): string {
	const s = String(raw ?? '').trim()
	if (!s) throw new Error('[otlp] endpoint must be non-empty')
	return s.replace(/\/+$/, '')
}
