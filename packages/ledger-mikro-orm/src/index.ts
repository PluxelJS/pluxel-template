export * from './mikro-orm.js'

import { LedgerMikroOrm } from './mikro-orm.js'

/** Convenience export for plugin registration. */
export const plugins = [LedgerMikroOrm] as const
