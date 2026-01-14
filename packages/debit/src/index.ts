export * from './builders.js'
export * from './core.js'
export * from './mikro-orm.js'
export * from './tigerbeetle.js'

import { DebitMikroOrm } from './mikro-orm.js'

/** Convenience export for plugin registration (local persistent default). */
export const plugins = [DebitMikroOrm] as const
