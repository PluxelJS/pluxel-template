import { decode, encode, encodeLines } from '@toon-format/toon'

/** Media type for TOON-encoded structured data. */
export const TOON_CONTENT_TYPE = 'text/toon; charset=utf-8'

export type ToonEncodeOptions = Parameters<typeof encode>[1]
export type ToonDecodeOptions = Parameters<typeof decode>[1]
export type ToonEncodeLinesOptions = Parameters<typeof encodeLines>[1]

/** Encode a JS value into TOON (token-efficient structured text). */
export function encodeToon(value: unknown, opts?: ToonEncodeOptions): string {
	return encode(value, opts as any)
}

/** Stream-encode a JS value into TOON line by line. */
export function encodeToonLines(value: unknown, opts?: ToonEncodeLinesOptions): Iterable<string> {
	return encodeLines(value, opts as any)
}

/** Decode TOON text into a JS value. */
export function decodeToon(text: string, opts?: ToonDecodeOptions): unknown {
	return decode(text, opts as any)
}

/** Explicit structured encoding format (no implicit defaults). */
export type StructuredFormat = 'json' | 'toon'

export type FormatStructuredOptions = {
	format: StructuredFormat
	jsonSpaces?: number
	toon?: ToonEncodeOptions
}

/**
 * Format a JS value as structured text for LLM prompts/tool calls.
 *
 * - `format: 'json'` → pretty JSON (default `jsonSpaces=2`).
 * - `format: 'toon'` → TOON text (more compact for tabular/list data).
 */
export function formatStructured(
	value: unknown,
	opts: { format: 'toon'; toon?: ToonEncodeOptions },
): { format: 'toon'; contentType: string; text: string }
export function formatStructured(
	value: unknown,
	opts: { format: 'json'; jsonSpaces?: number },
): { format: 'json'; contentType: string; text: string }
export function formatStructured(
	value: unknown,
	opts: FormatStructuredOptions,
): { format: StructuredFormat; contentType: string; text: string } {
	if (opts.format === 'toon') {
		return {
			format: 'toon',
			contentType: TOON_CONTENT_TYPE,
			text: encodeToon(value, opts.toon),
		}
	}

	const spaces = Number.isFinite(opts.jsonSpaces) ? Math.max(0, Math.min(8, Math.floor(opts.jsonSpaces!))) : 2
	return {
		format: 'json',
		contentType: 'application/json; charset=utf-8',
		text: JSON.stringify(value, null, spaces),
	}
}
