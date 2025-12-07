import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import * as echarts from 'echarts'
import fs from 'node:fs'
import path from 'node:path'
import FontManager from 'pluxel-plugin-font-manager'
import { Image, createCanvas as createSkiaCanvas, loadImage as loadImageFromCanvas } from 'pluxel-plugin-napi-rs/canvas'

export { echarts }

const CfgSchema = v.object({
  width: v.optional(v.number(), 1000),
  height: v.optional(v.number(), 700),
  themesDir: v.optional(v.string(), 'node-rs/canvas/echarts'),
  defaultTheme: v.optional(v.string(), 'light'),
  demoRoute: v.optional(v.string(), '/echarts/demo'),
  fontKey: v.optional(v.string(), 'sans'),
})

type PluginConfig = Config<typeof CfgSchema>

let platformReady = false
function ensurePlatform() {
  if (platformReady) return

  echarts.setPlatformAPI({
    createCanvas(width = 32, height = 32) {
      return createSkiaCanvas(width, height) as any
    },
    loadImage(src, onload, onerror) {
      const img = new Image()
      img.onload = onload
      img.onerror = onerror

      if (typeof src === 'string' && src.trimStart().startsWith('data:')) {
        const commaIdx = src.indexOf(',')
        const encoding = src.lastIndexOf('base64', commaIdx) < 0 ? 'utf-8' : 'base64'
        const data = Buffer.from(src.slice(commaIdx + 1), encoding)
        img.src = data
        return img as any
      }

      void Promise.resolve(loadImageFromCanvas(src as any)).then(
        (loaded) => {
          const content = (loaded as any)?.src ?? (loaded as any)
          img.src = content
        },
        onerror
      )
      return img as any
    },
  })

  platformReady = true
}

@Plugin({ name: 'echarts' })
export class Echarts extends BasePlugin {
  @Config(CfgSchema)
  private config!: PluginConfig

  constructor(private readonly fontManager: FontManager) {
    super()
  }

  override async init(_abort: AbortSignal): Promise<void> {
    ensurePlatform()
    this.registerThemes()
    this.registerDemoRoute()
    this.ctx.logger.info('Echarts initialized')
  }

  override async stop(_abort: AbortSignal): Promise<void> {
    this.ctx.logger.info('Echarts stopped')
  }

  async createChart(
    options: echarts.EChartsOption,
    overrides?: { width?: number; height?: number; theme?: string; fontKey?: string },
  ) {
    ensurePlatform()
    const width = overrides?.width ?? this.config.width
    const height = overrides?.height ?? this.config.height
    const theme = overrides?.theme ?? this.config.defaultTheme
    const fontKey = overrides?.fontKey ?? this.config.fontKey ?? 'sans'
    const fontFamily = this.fontManager.getFontFamilyString(fontKey)

    const canvas = createSkiaCanvas(width, height)

    // Keep animation off by default for server-side rendering
    const appliedOptions: echarts.EChartsOption = { animation: false, ...options }
    appliedOptions.textStyle = {
      fontFamily,
      fontSize: 16,
      ...(appliedOptions.textStyle ?? {}),
    }

    const chart = echarts.init(canvas as any, theme, {
      renderer: 'canvas',
      width,
      height,
    })
    chart.setOption(appliedOptions)

    return {
      canvas,
      chart,
      dispose: () => chart.dispose(),
    }
  }

  async createChartPNG(
    options: echarts.EChartsOption,
    overrides?: { width?: number; height?: number; theme?: string; fontFamily?: string; fontKey?: string },
  ): Promise<Buffer> {
    const { canvas, dispose } = await this.createChart(options, overrides)
    try {
      if (typeof (canvas as any).toBuffer === 'function') {
        return (canvas as any).toBuffer('image/png') as Buffer
      }
      if (typeof (canvas as any).encode === 'function') {
        const encoded = await (canvas as any).encode('png')
        return Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded)
      }
      throw new Error('Canvas backend does not support toBuffer/encode')
    } finally {
      dispose()
    }
  }

  private registerThemes() {
    const themesDir = path.resolve(process.cwd(), this.config.themesDir)
    fs.mkdirSync(themesDir, { recursive: true })

    const files = fs.readdirSync(themesDir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const filePath = path.join(themesDir, file)
      const themeName = path.basename(file, '.json')
      try {
        const theme = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        echarts.registerTheme(themeName, theme)
        this.ctx.logger.info(`ECharts theme loaded: ${themeName}`)
      } catch (err) {
        this.ctx.logger.warn(`Failed to load theme ${filePath}`, err)
      }
    }
  }

  private registerDemoRoute() {
    if (!this.config.demoRoute) return
    const route = this.config.demoRoute

    this.ctx.honoService.modifyApp((app) => {
      app.get(route, async (c) => {
        this.ctx.logger.info(`[echarts] GET ${route}`)

        const width = Number(c.req.query('w')) || this.config.width
        const height = Number(c.req.query('h')) || this.config.height
        const theme = c.req.query('theme') || this.config.defaultTheme

        const buffer = await this.createChartPNG(
          {
            title: { text: 'ECharts Demo' },
            tooltip: {},
            legend: { data: ['销量'] },
            xAxis: { data: ['衬衫', '羊毛衫', '雪纺衫', '裤子', '高跟鞋', '袜子'] },
            yAxis: {},
            series: [{ name: '销量', type: 'bar', data: [5, 20, 36, 10, 10, 20] }],
          },
          { width, height, theme },
        )

        return c.body(buffer as any, 200, { 'content-type': 'image/png' })
      })
    })
  }
}
