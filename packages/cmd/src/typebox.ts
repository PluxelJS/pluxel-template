import { Type } from '@sinclair/typebox'
import type { ObjectOptions, TProperties, TObject } from '@sinclair/typebox'

export { Type }
export * as TypeBox from '@sinclair/typebox'
export type { Static, TSchema, TAnySchema, TProperties } from '@sinclair/typebox'

/**
 * Convenience helper for "strict" objects.
 *
 * TypeBox defaults `additionalProperties` to `true` unless specified.
 * In @pluxel/cmd, object inputs are typically used as parameter bags; keeping them
 * strict avoids accidental acceptance of unknown keys.
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
