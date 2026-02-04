export * from './s3mini_plugin'

import { S3MiniPlugin } from './s3mini_plugin'

export { S3MiniPlugin as default } from './s3mini_plugin'

export const plugins = [S3MiniPlugin] as const

