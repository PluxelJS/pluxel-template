export { Ax } from './core'
export type { AxProfileId, AxProfilePublic } from './profiles'

import { AxHub } from './hub'
export { AxHub } from './hub'

/** Default provider plugin (profiles + vault + UI). */
export { AxHub as default } from './hub'

/** Convenience export for plugin registration. */
export const plugins = [AxHub] as const
