export * from './core'
export * from './cache'
export * from './decorators'
export * from './memory'
export * from './rates'

import { KvMemory } from './memory.js'

/** Default provider plugin: in-memory KV (`KvMemory`). */
export { KvMemory as default } from './memory.js'

/**
 * Convenience export for plugin registration.
 *
 * ```ts
 * import { plugins } from 'pluxel-plugin-kv'
 * ```
 */
export const plugins = [KvMemory] as const
