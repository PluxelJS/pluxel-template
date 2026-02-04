import type { Effects } from '@pluxel/core/services'

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			/** EffectsService（迁移自 ScopeService.collectEffect） */
			effects: Effects
		}
	}
}

export {}

