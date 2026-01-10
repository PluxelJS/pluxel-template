export * from './redis_plugin'
export * from './rates'

import { RedisPlugin } from './redis_plugin.js'
import { Rates } from './rates.js'

export { RedisPlugin as default } from './redis_plugin.js'

export const plugins = [RedisPlugin, Rates] as const
