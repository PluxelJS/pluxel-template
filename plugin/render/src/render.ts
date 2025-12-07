import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { Leafer, Rect, useCanvas } from '@leafer-ui/node'
import * as skia from 'pluxel-plugin-napi-rs/canvas'

const CfgSchema = v.object({
  test: v.optional(v.boolean(), true),
})

let canvasRegistered = false
function patchCanvasBackend(canvasLib: any) {
  const CanvasElement = (canvasLib as any)?.CanvasElement || (canvasLib as any)?.Canvas
  if (
    CanvasElement &&
    typeof CanvasElement.prototype.toDataURLSync !== 'function' &&
    typeof CanvasElement.prototype.toDataURL === 'function'
  ) {
    CanvasElement.prototype.toDataURLSync = function toDataURLSync(type?: string, options?: any) {
      const normalized = type && typeof type === 'string' && type.includes('/') ? type : `image/${type || 'png'}`
      return this.toDataURL(normalized, options)
    }
  }
}

@Plugin({ name: 'pluxel-plugin-render' })
export class Render extends BasePlugin {
  @Config(CfgSchema)
  private config!: Config<typeof CfgSchema>

  async init(_abort: AbortSignal): Promise<void> {
    if (!canvasRegistered) {
      patchCanvasBackend(skia)
      useCanvas('skia', skia)
      canvasRegistered = true
    }

    this.ctx.honoService.modifyApp((app) => {
      app.get('/render/demo', async (c) => {
        this.ctx.logger.info('[render] GET /render/demo')

        const leafer = new Leafer({ width: 800, height: 600 })
        leafer.add(Rect.one({ fill: '#32cd79' }, 100, 100))

        const { data } = await leafer.export('png')
        leafer.destroy?.()

        return c.html(`<img src="${data}" />`)
      })
    })

    this.ctx.logger.info('Render initialized')
  }

  async stop(_abort: AbortSignal): Promise<void> {
    this.ctx.logger.info('Render stopped')
  }
}

export default Render
