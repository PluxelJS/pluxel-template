import { RpcTarget } from '@pluxel/hmr/capnweb'
import type { FontManager } from './font-manager'

export class FontManagerRpc extends RpcTarget {
	constructor(private readonly plugin: FontManager) {
		super()
	}

	snapshot() {
		return this.plugin.getSnapshot('rpc')
	}

	reload(reason?: string) {
		return this.plugin.reloadFonts(reason ?? 'rpc')
	}

	fontStack(key?: string) {
		return this.plugin.getFontStack(key)
	}

	primary(key?: string) {
		return this.plugin.getPrimaryFont(key)
	}

	setPreferred(key: string, families: string[]) {
		return this.plugin.setPreferredFamilies(key, families)
	}

	resolved(keys?: string[]) {
		return this.plugin.getResolvedStacks(keys)
	}
}

