export * from './core'
export * from './libsql'

import { DrizzleOrmLibsql } from './libsql.js'
export { DrizzleOrmLibsql as default } from './libsql.js'

/**
 * Convenience export for plugin registration.
 *
 * ```ts
 * import { plugins } from 'pluxel-plugin-drizzle-orm'
 * ```
 */
export const plugins = [DrizzleOrmLibsql] as const
