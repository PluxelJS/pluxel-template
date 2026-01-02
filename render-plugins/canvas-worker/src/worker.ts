import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'

import { Image, Leafer, Rect, Text, useCanvas } from '@leafer-ui/node'
import {
  GlobalFonts,
  Image as SkiaImage,
  createCanvas as createSkiaCanvas,
  loadImage as loadImageFromCanvas,
} from 'pluxel-plugin-napi-rs/canvas'
import * as skia from 'pluxel-plugin-napi-rs/canvas'

import type { FontBootstrap, FontSourcePayload, LeaferExports, LeaferStatic, RenderNode, RenderScene, WorkerJob, WorkerRenderResult } from './types'

type RuntimeState = {
  canvasRegistered: boolean
  echartsPlatformReady: boolean
  loadedThemeFiles: Set<string>
  echartsModulePromise: Promise<typeof import('echarts')> | null
  fontsLoadedKey: string | null
}

const runtime: RuntimeState = {
  canvasRegistered: false,
  echartsPlatformReady: false,
  loadedThemeFiles: new Set(),
  echartsModulePromise: null,
  fontsLoadedKey: null,
}

function patchCanvasBackend(canvasLib: any) {
  const CanvasElement = canvasLib?.CanvasElement || canvasLib?.Canvas
  if (
    CanvasElement
    && typeof CanvasElement.prototype.toDataURLSync !== 'function'
    && typeof CanvasElement.prototype.toDataURL === 'function'
  ) {
    CanvasElement.prototype.toDataURLSync = function toDataURLSync(type?: string, options?: any) {
      const normalized = type && typeof type === 'string' && type.includes('/') ? type : `image/${type || 'png'}`
      return this.toDataURL(normalized, options)
    }
  }
}

function ensureCanvas() {
  if (runtime.canvasRegistered) return
  patchCanvasBackend(skia)
  useCanvas('skia', skia as any)
  runtime.canvasRegistered = true
}

async function getEcharts(): Promise<typeof import('echarts')> {
  if (!runtime.echartsModulePromise) {
    runtime.echartsModulePromise = import('echarts')
  }
  return runtime.echartsModulePromise
}

async function ensureEchartsPlatform(echarts: typeof import('echarts')) {
  if (runtime.echartsPlatformReady) return
  echarts.setPlatformAPI({
    createCanvas(width = 32, height = 32) {
      return createSkiaCanvas(width, height) as any
    },
    loadImage(src, onload, onerror) {
      const img = new SkiaImage()
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
        (loaded: any) => {
          const content = loaded?.src ?? loaded
          img.src = content
        },
        onerror,
      )
      return img as any
    },
  })
  runtime.echartsPlatformReady = true
}

function fontKey(fonts?: FontBootstrap) {
  if (!fonts?.sources?.length) return 'none'
  const normalized = fonts.sources
    .map((source) => `${source.type}:${path.resolve(source.path)}:${source.alias ?? ''}`)
    .sort()
  return normalized.join('|')
}

function loadFontsOnce(fonts?: FontBootstrap) {
  const key = fontKey(fonts)
  if (runtime.fontsLoadedKey === key) return

  if (!fonts?.sources?.length) {
    runtime.fontsLoadedKey = key
    return
  }

  for (const source of fonts.sources) {
    loadFontSource(source)
  }
  runtime.fontsLoadedKey = key
}

function loadFontSource(source: FontSourcePayload) {
  const absPath = path.resolve(source.path)
  try {
    if (source.type === 'dir') {
      GlobalFonts.loadFontsFromDir(absPath)
    } else if (source.type === 'file') {
      GlobalFonts.registerFromPath(absPath, source.alias)
    }
  } catch (err) {
    console.warn('[canvas-worker] font load failed', absPath, err)
  }
}

function registerThemesFromDir(echarts: typeof import('echarts'), dir?: string) {
  if (!dir) return
  const abs = path.resolve(dir)
  if (!fs.existsSync(abs)) return

  const files = fs.readdirSync(abs)
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const filePath = path.join(abs, file)
    if (runtime.loadedThemeFiles.has(filePath)) continue
    try {
      const theme = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      const themeName = path.basename(file, '.json')
      echarts.registerTheme(themeName, theme)
      runtime.loadedThemeFiles.add(filePath)
    } catch (err) {
      console.warn('[canvas-worker] failed to load theme', filePath, err)
    }
  }
}

function addNodes(parent: Leafer, nodes: RenderNode[], fontFamily: string) {
  for (const node of nodes) {
    const instance = createNode(node, fontFamily)
    if (instance) {
      ;(parent as any).add(instance)
      if ((node as any).children?.length && 'add' in (instance as any)) {
        addNodes(instance as any, (node as any).children, fontFamily)
      }
    }
  }
}

function createNode(node: RenderNode, fontFamily: string): any | null {
  switch (node.type) {
    case 'rect':
      return Rect.one(
        {
          fill: node.fill ?? '#ffffff',
          cornerRadius: node.cornerRadius,
          opacity: node.opacity,
          stroke: node.stroke,
          strokeWidth: node.strokeWidth,
          x: node.x,
          y: node.y,
        },
        node.width,
        node.height,
      )
    case 'text':
      return new Text({
        text: node.text,
        x: node.x,
        y: node.y,
        fill: node.fill ?? '#111',
        fontSize: node.fontSize ?? 18,
        fontFamily,
        fontWeight: node.fontWeight,
        textAlign: node.textAlign,
        maxWidth: node.maxWidth,
      })
    case 'image':
      return new Image({
        url: (node as any).url ?? (node as any).src,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        opacity: node.opacity,
        mode: (node as any).mode,
      })
    case 'group':
      return new Leafer({
        width: (node as any).width ?? 0,
        height: (node as any).height ?? 0,
      }) as any
    default:
      return null
  }
}

function bufferFromExport(data: any): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (typeof data === 'string') {
    const base64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data
    return Buffer.from(base64, 'base64')
  }
  if (data && typeof data.data === 'string') return bufferFromExport(data.data)
  if (data && Buffer.isBuffer(data.data)) return data.data
  throw new Error('Unsupported export data type')
}

async function renderLeafui(job: Extract<WorkerJob, { kind: 'leafui' }>): Promise<WorkerRenderResult> {
  ensureCanvas()
  loadFontsOnce(job.fonts)
  const started = Date.now()
  const payload = job.payload
  const leafer = createLeaferFromPayload(payload)
  try {
    const exportResult = await (leafer as any).export('png')
    const buffer = bufferFromExport(exportResult?.data ?? exportResult)
    return {
      buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      durationMs: Date.now() - started,
      meta: { width: payload.width, height: payload.height },
    }
  } finally {
    ;(leafer as any).destroy?.()
  }
}

async function renderEcharts(job: Extract<WorkerJob, { kind: 'echarts' }>): Promise<WorkerRenderResult> {
  ensureCanvas()
  const echarts = await getEcharts()
  await ensureEchartsPlatform(echarts)
  loadFontsOnce(job.fonts)

  const started = Date.now()
  const payload = job.payload
  registerThemesFromDir(echarts, payload.themesDir)

  const canvas = createSkiaCanvas(payload.width, payload.height) as any
  const appliedOptions: import('echarts').EChartsOption = { animation: false, ...payload.options }
  appliedOptions.textStyle = {
    fontFamily: payload.fontFamily,
    fontSize: 16,
    ...(appliedOptions.textStyle ?? {}),
  }

  const chart = echarts.init(canvas, payload.theme, {
    renderer: 'canvas',
    width: payload.width,
    height: payload.height,
  })

  let buffer: Buffer
  try {
    chart.setOption(appliedOptions)

    if (typeof canvas.toBuffer === 'function') {
      buffer = canvas.toBuffer('image/png') as Buffer
    } else if (typeof canvas.encode === 'function') {
      const encoded = await canvas.encode('png')
      buffer = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded)
    } else {
      throw new Error('Canvas backend does not support toBuffer/encode')
    }
  } finally {
    chart.dispose()
  }

  return {
    buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    durationMs: Date.now() - started,
    meta: { width: payload.width, height: payload.height },
  }
}

function applyTree(leafer: LeaferExports, tree: any) {
  if (!tree) return false
  if (leafer.tree && typeof (leafer.tree as any).set === 'function') {
    try {
      ;(leafer.tree as any).set(tree.children ? { children: tree.children } : tree)
      return true
    } catch (err) {
      console.warn('[canvas-worker] failed to set tree', err)
    }
  }
  return false
}

function createLeaferFromPayload(payload: { scene?: RenderScene; tree?: any; width: number; height: number; fontFamily: string; background?: string | null }): LeaferExports {
  const { scene, tree, width, height, fontFamily, background } = payload
  const leafer = new Leafer({ width, height }) as any as LeaferExports

  if (tree && applyTree(leafer, tree)) {
    if (background) {
      leafer.add(Rect.one({ fill: background, x: 0, y: 0 }, width, height))
    }
    return leafer
  }

  if (scene?.kind === 'leafer-json') {
    const LeaferCtor = Leafer as any as LeaferStatic
    if (typeof LeaferCtor.fromJSON === 'function') {
      const built = LeaferCtor.fromJSON(scene.json)
      if (built) return built as any
    }
    if (typeof (leafer as any).load === 'function') {
      void (leafer as any).load(scene.json)
    } else if (typeof (leafer as any).import === 'function') {
      void (leafer as any).import(scene.json)
    }
    return leafer
  }

  if (background) {
    leafer.add(Rect.one({ fill: background, x: 0, y: 0 }, width, height))
  }

  if (scene?.kind === 'nodes') {
    addNodes(leafer as any, scene.nodes, fontFamily)
  }
  return leafer
}

export default async function run(job: WorkerJob): Promise<WorkerRenderResult> {
  switch (job.kind) {
    case 'leafui':
      return renderLeafui(job)
    case 'echarts':
      return renderEcharts(job)
    default:
      throw new Error(`Unknown worker job: ${(job as any)?.kind}`)
  }
}

