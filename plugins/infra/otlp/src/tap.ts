import type { OtlpAttributes, OtlpLogRecordInput, OtlpMetricPointInput, OtlpSpanInput } from './core.js'

export type OtlpTapMeta = {
	callerId: string
	callerName: string
	/**
	 * Attributes applied at the signal item level (provider + caller).
	 */
	attrs: OtlpAttributes
	/**
	 * OpenTelemetry Resource attributes (service.name, etc).
	 *
	 * Note: exporter encodes these as Resource; taps may use them for local viewing.
	 */
	resourceAttrs: OtlpAttributes
	/**
	 * OpenTelemetry InstrumentationScope (name/version).
	 *
	 * Note: exporter encodes this as Scope; taps may use it for local viewing.
	 */
	scope: { name: string; version?: string }
}

export type OtlpTap = {
	onLogs?: (items: readonly OtlpLogRecordInput[], meta: OtlpTapMeta) => void
	onTraces?: (items: readonly OtlpSpanInput[], meta: OtlpTapMeta) => void
	onMetrics?: (items: readonly OtlpMetricPointInput[], meta: OtlpTapMeta) => void
}
