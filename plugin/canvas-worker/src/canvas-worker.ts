import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import Tinypool from 'tinypool'
import FontManager from 'pluxel-plugin-font-manager'

import type {
  EchartsRenderPayload,
  EchartsRenderRequest,
  FontBootstrap,
  FontSourcePayload,
  LeafRenderOptions,
  LeafRenderPayload,
  LeafRenderRequest,
  LeaferTree,
  RenderNode,
  RenderScene,
  RenderedImage,
  WorkerJob,
  WorkerRenderResult,
  WorkerResult,
} from './types'
export { exportTree, tryExportTree } from './leaf-tools'

const DEFAULT_IDLE_TIMEOUT = 30_000
const DEFAULT_WIDTH = 1000
const DEFAULT_HEIGHT = 700
const DEFAULT_FONT_KEY = 'sans'
const DEFAULT_ECHARTS_THEME = 'light'
const DEFAULT_THEMES_DIR = 'node-rs/canvas/echarts'

const CfgSchema = v.object({
  maxThreads: v.optional(v.number()),
  idleTimeout: v.optional(v.number(), DEFAULT_IDLE_TIMEOUT),
  defaultWidth: v.optional(v.number(), DEFAULT_WIDTH),
  defaultHeight: v.optional(v.number(), DEFAULT_HEIGHT),
  defaultFontKey: v.optional(v.string(), DEFAULT_FONT_KEY),
  defaultEchartsTheme: v.optional(v.string(), DEFAULT_ECHARTS_THEME),
  defaultThemesDir: v.optional(v.string(), DEFAULT_THEMES_DIR),
})

const workerEntryCandidates = ['worker.js', 'worker.mjs']

function resolveWorkerEntrypoint(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  const pkgRoot = path.resolve(currentDir, '..')
  const candidates = [
    ...workerEntryCandidates.map((file) => path.join(currentDir, file)),
    ...workerEntryCandidates.map((file) => path.join(pkgRoot, 'dist', file)),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return pathToFileURL(candidate).href
    }
  }

  throw new Error(
    `[CanvasWorker] worker bundle not found. Tried: ${candidates.join(
      ', ',
    )}. Run "pnpm --filter pluxel-plugin-canvas-worker build" first.`,
  )
}

@Plugin({ name: 'CanvasWorker', type: 'service' })
export class CanvasWorker extends BasePlugin {
  @Config(CfgSchema)
  private config!: Config<typeof CfgSchema>

  private pool: Tinypool | null = null
  private fontBootstrap: FontBootstrap | null = null
  private readonly workerEntrypoint = resolveWorkerEntrypoint()

  constructor(private readonly fontManager: FontManager) {
    super()
  }

  override async init(): Promise<void> {
    await this.refreshFontBootstrap()
    this.ensurePool()
    this.ctx.logger.info('[CanvasWorker] ready')
  }

  override async stop(): Promise<void> {
    if (this.pool) {
      await this.pool.destroy()
      this.pool = null
    }
    this.ctx.logger.info('[CanvasWorker] stopped')
  }

  async renderLeafImage(request: LeafRenderRequest): Promise<RenderedImage> {
    const payload = this.buildLeafPayloadFromRequest(request)
    const raw = await this.renderLeaf(payload)
    return this.toRenderedImage(raw, request.returnDataURL)
  }

  async renderEchartsChart(request: EchartsRenderRequest): Promise<RenderedImage> {
    const payload = this.buildEchartsPayloadFromRequest(request)
    const raw = await this.renderEcharts(payload)
    return this.toRenderedImage(raw, request.returnDataURL)
  }

  async renderLeaf(payload: LeafRenderPayload): Promise<WorkerResult> {
    const fonts = await this.getFontBootstrap()
    return this.run({ kind: 'leafui', payload, fonts })
  }

  async renderLeafNodes(
    nodes: RenderNode[],
    options: LeafRenderOptions & { fontFamily?: string },
  ): Promise<WorkerResult> {
    const payload = this.buildLeafPayloadFromRequest({ ...options, nodes })
    return this.renderLeaf(payload)
  }

  async renderLeafScene(
    scene: RenderScene,
    options: LeafRenderOptions & { fontFamily?: string },
  ): Promise<WorkerResult> {
    const payload = this.buildLeafPayloadFromRequest({ ...options, scene })
    return this.renderLeaf(payload)
  }

  async renderLeafTree(
    tree: LeaferTree,
    options: LeafRenderOptions & { fontFamily?: string },
  ): Promise<WorkerResult> {
    const payload = this.buildLeafPayloadFromRequest({ ...options, tree })
    return this.renderLeaf(payload)
  }

  async renderEcharts(payload: EchartsRenderPayload): Promise<WorkerResult> {
    const fonts = await this.getFontBootstrap()
    return this.run({ kind: 'echarts', payload, fonts })
  }

  async renderEchartsOption(
    options: EchartsRenderPayload['options'],
    overrides: Partial<Omit<EchartsRenderPayload, 'options' | 'fontFamily' | 'theme'>> & {
      width?: number
      height?: number
      theme?: string
      fontFamily?: string
      fontKey?: string
      themesDir?: string
    } = {},
  ): Promise<WorkerResult> {
    const payload = this.buildEchartsPayloadFromRequest({
      options,
      width: overrides.width,
      height: overrides.height,
      theme: overrides.theme,
      fontFamily: overrides.fontFamily,
      fontKey: overrides.fontKey,
      themesDir: overrides.themesDir,
    })
    return this.renderEcharts(payload)
  }

  private buildLeafPayloadFromRequest(request: LeafRenderRequest): LeafRenderPayload {
    const width = request.width ?? this.config.defaultWidth ?? DEFAULT_WIDTH
    const height = request.height ?? this.config.defaultHeight ?? DEFAULT_HEIGHT
    const scene = request.scene ?? (request.nodes ? { kind: 'nodes', nodes: request.nodes } : undefined)
    return {
      width,
      height,
      background: request.background ?? null,
      fontFamily: this.resolveFontFamily(request.fontFamily, request.fontKey),
      scene,
      tree: request.tree,
    }
  }

  private buildEchartsPayloadFromRequest(request: EchartsRenderRequest): EchartsRenderPayload {
    const width = request.width ?? this.config.defaultWidth ?? DEFAULT_WIDTH
    const height = request.height ?? this.config.defaultHeight ?? DEFAULT_HEIGHT
    const theme = request.theme ?? this.config.defaultEchartsTheme ?? DEFAULT_ECHARTS_THEME

    return {
      width,
      height,
      theme,
      fontFamily: this.resolveFontFamily(request.fontFamily, request.fontKey),
      options: request.options,
      themesDir: this.resolveThemesDir(request.themesDir),
    }
  }

  private toRenderedImage(raw: WorkerRenderResult, includeDataURL?: boolean): RenderedImage {
    const buffer = Buffer.from(raw.buffer)
    const mime = 'image/png'
    return {
      buffer,
      mime,
      dataURL: includeDataURL ? `data:${mime};base64,${buffer.toString('base64')}` : undefined,
      durationMs: raw.durationMs,
      meta: raw.meta,
    }
  }

  private resolveThemesDir(customDir?: string) {
    const dir = customDir ?? this.config.defaultThemesDir ?? DEFAULT_THEMES_DIR
    if (!dir) return undefined
    const abs = path.resolve(process.cwd(), dir)
    fs.mkdirSync(abs, { recursive: true })
    return abs
  }

  private resolveFontFamily(preferred?: string, fontKey?: string) {
    const key = fontKey ?? this.config.defaultFontKey ?? DEFAULT_FONT_KEY
    return this.fontManager.resolveFontFamily(preferred, key)
  }

  private async run(job: WorkerJob): Promise<WorkerRenderResult> {
    this.ensurePool()
    return this.pool!.run(job)
  }

  private ensurePool() {
    if (this.pool) return
    const maxThreads = this.config.maxThreads ?? Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1)
    const idleTimeout = this.config.idleTimeout ?? DEFAULT_IDLE_TIMEOUT

    this.pool = new Tinypool({
      filename: this.workerEntrypoint,
      maxThreads,
      idleTimeout,
      concurrentTasksPerWorker: 1,
      isolateWorkers: false,
    })
  }

  private async getFontBootstrap(): Promise<FontBootstrap | undefined> {
    if (!this.fontBootstrap) {
      await this.refreshFontBootstrap()
    }
    return this.fontBootstrap ?? undefined
  }

  private async refreshFontBootstrap() {
    try {
      const snapshot = await this.fontManager.getSnapshot('canvas-worker')
      const sources: FontSourcePayload[] = []
      for (const src of snapshot.sources ?? []) {
        if (!src.path || (src.type !== 'dir' && src.type !== 'file')) continue
        sources.push({ path: src.path, alias: src.alias, type: src.type })
      }
      this.fontBootstrap = sources.length ? { sources } : null
    } catch (err) {
      this.ctx.logger.warn(err, '[CanvasWorker] failed to build font bootstrap')
      this.fontBootstrap = null
    }
  }
}

export type {
  RenderNode,
  RenderScene,
  LeafRenderPayload,
  LeafRenderOptions,
  LeafRenderRequest,
  LeaferTree,
  EchartsRenderPayload,
  EchartsRenderRequest,
  RenderedImage,
  WorkerResult,
} from './types'
