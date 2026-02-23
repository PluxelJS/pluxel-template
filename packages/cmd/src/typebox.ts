import { Type } from '@sinclair/typebox'
import type { ObjectOptions, TProperties, TObject } from '@sinclair/typebox'

export { Type }
export * as TypeBox from '@sinclair/typebox'
export type { Static, TSchema, TAnySchema, TProperties } from '@sinclair/typebox'

/**
 * Convenience helper for "strict" objects.
 *
 * Notes:
 * - TypeBox treats omitted `additionalProperties` as "allow unknown keys".
 * - @pluxel/cmd additionally normalizes object schemas to strict-by-default at validation time
 *   (when `additionalProperties` is omitted), including nested objects.
 *
 * This helper is primarily for intent + ergonomics when authoring schemas.
 */
export const obj = <P extends TProperties>(
	properties: P,
	options?: Omit<ObjectOptions, 'additionalProperties'> & { additionalProperties?: boolean },
): TObject<P> =>
	Type.Object(properties, { additionalProperties: false, ...(options ?? {}) }) as any

/** Convenience helper for "open" objects (unknown keys allowed). */
export const openObj = <P extends TProperties>(
	properties: P,
	options?: Omit<ObjectOptions, 'additionalProperties'>,
): TObject<P> =>
	Type.Object(properties, { additionalProperties: true, ...(options ?? {}) }) as any
