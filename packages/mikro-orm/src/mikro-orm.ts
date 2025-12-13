import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'

const CfgSchema = v.object({
  test: v.optional(v.boolean(), true),
})

@Plugin({ name: 'pluxel-plugin-mikro-orm' })
export class MikroOrm extends BasePlugin {
  @Config(CfgSchema)
  private config!: Config<typeof CfgSchema>

  async init(_abort: AbortSignal): Promise<void> {
    this.ctx.logger.info('MikroOrm initialized')
  }

  async stop(_abort: AbortSignal): Promise<void> {
    this.ctx.logger.info('MikroOrm stopped')
  }
}

export default MikroOrm
