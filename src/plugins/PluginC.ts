import { BasePlugin, Plugin } from '@pluxel/hmr'
import {v} from '@pluxel/hmr/config'

@Plugin({ name: 'PluginC', type: 'hook' })
export class PluginC extends BasePlugin {
	init(): void {
		this.ctx.logger.info('PluginC initialized')

		const graphService = this.ctx.graphql
		const { resolver, query } = graphService.factory
		const _helloResolver = resolver({
			hello: query(v.string())
				.input({ name: v.nullish(v.string(), 'World') })
				.resolve(({ name }) => `Hello, ${name}!`),
		})
	}
}
