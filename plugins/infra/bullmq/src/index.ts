export * from './bullmq_config'
export * from './bullmq_types'
export * from './bullboard_feature'
export * from './bullmq_plugin'

import { BullMQPlugin } from './bullmq_plugin'

export { BullMQPlugin as default } from './bullmq_plugin'

export const plugins = [BullMQPlugin] as const
