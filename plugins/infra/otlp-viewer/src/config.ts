import { f, v } from '@pluxel/hmr/config'

export const OtlpViewerRetentionCfgSchema = v.object({
	maxLogs: v.pipe(v.optional(v.number(), 200_000), f.formMeta({ label: 'Max logs' }), f.numberMeta({ min: 0, step: 1000 })),
	maxSpans: v.pipe(v.optional(v.number(), 200_000), f.formMeta({ label: 'Max spans' }), f.numberMeta({ min: 0, step: 1000 })),
	maxMetrics: v.pipe(v.optional(v.number(), 500_000), f.formMeta({ label: 'Max metric points' }), f.numberMeta({ min: 0, step: 1000 })),
})

export const OtlpViewerConfigSchema = v.object({
	enabled: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: 'Enable', description: 'Enable OTLP viewer capture + local DuckDB store.' }),
		f.booleanMeta({ control: 'switch' }),
	),
	dbPath: v.pipe(
		v.optional(v.string(), ':memory:'),
		f.formMeta({ label: 'DuckDB path', description: 'Use :memory: for in-memory (default) or a file path for persistence.' }),
	),
	retention: v.pipe(
		v.optional(OtlpViewerRetentionCfgSchema, { maxLogs: 200_000, maxSpans: 200_000, maxMetrics: 500_000 }),
		f.formMeta({ label: 'Retention', description: 'Keep newest N rows per table (older rows are deleted during flush).' }),
	),
	flushIntervalMs: v.pipe(
		v.optional(v.number(), 200),
		f.formMeta({ label: 'Flush interval (ms)', description: 'Batch inserts into DuckDB to reduce overhead.' }),
		f.numberMeta({ min: 5, step: 5 }),
	),
	maxBatchRows: v.pipe(
		v.optional(v.number(), 2000),
		f.formMeta({ label: 'Max batch rows', description: 'Max rows per flush per table.' }),
		f.numberMeta({ min: 1, step: 100 }),
	),
	maxPendingRows: v.pipe(
		v.optional(v.number(), 50_000),
		f.formMeta({ label: 'Max pending rows', description: 'Bound in-memory pending rows per table (0 = unlimited; not recommended).' }),
		f.numberMeta({ min: 0, step: 1000 }),
	),
})

export type OtlpViewerConfig = v.InferOutput<typeof OtlpViewerConfigSchema>
