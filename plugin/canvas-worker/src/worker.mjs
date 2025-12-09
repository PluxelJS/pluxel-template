// @ts-check
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'

import { Leafer, Rect, Text, Image, useCanvas } from '@leafer-ui/node'
import {
  GlobalFonts,
  Image as SkiaImage,
  createCanvas as createSkiaCanvas,
  loadImage as loadImageFromCanvas,
} from 'pluxel-plugin-napi-rs/canvas'
import * as skia from 'pluxel-plugin-napi-rs/canvas'

/** @typedef {import('./types').FontBootstrap} FontBootstrap */
/** @typedef {import('./types').FontSourcePayload} FontSourcePayload */
/** @typedef {import('./types').LeaferExports} LeaferExports */
/** @typedef {import('./types').LeaferStatic} LeaferStatic */
/** @typedef {import('./types').RenderNode} RenderNode */
/** @typedef {import('./types').RenderScene} RenderScene */
/** @typedef {import('./types').WorkerJob} WorkerJob */
/** @typedef {import('./types').WorkerRenderResult} WorkerRenderResult */

/**
 * @typedef {Object} RuntimeState
 * @property {boolean} canvasRegistered
 * @property {boolean} echartsPlatformReady
 * @property {Set<string>} loadedThemeFiles
 * @property {Promise<typeof import('echarts')>|null} echartsModulePromise
 * @property {string|null} fontsLoadedKey
 */

/** @type {RuntimeState} */
const runtime = {
  canvasRegistered: false,
  echartsPlatformReady: false,
  loadedThemeFiles: new Set(),
  echartsModulePromise: null,
  fontsLoadedKey: null,
}

function patchCanvasBackend(canvasLib) {
  const CanvasElement = canvasLib?.CanvasElement || canvasLib?.Canvas
  if (
    CanvasElement &&
    typeof CanvasElement.prototype.toDataURLSync !== 'function' &&
    typeof CanvasElement.prototype.toDataURL === 'function'
  ) {
    CanvasElement.prototype.toDataURLSync = function toDataURLSync(type, options) {
      const normalized = type && typeof type === 'string' && type.includes('/') ? type : `image/${type || 'png'}`
      return this.toDataURL(normalized, options)
    }
  }
}

function ensureCanvas() {
  if (runtime.canvasRegistered) return
  patchCanvasBackend(skia)
  useCanvas('skia', skia)
  runtime.canvasRegistered = true
}

/** @returns {Promise<typeof import('echarts')>} */
async function getEcharts() {
  if (!runtime.echartsModulePromise) {
    runtime.echartsModulePromise = import('echarts')
  }
  return runtime.echartsModulePromise
}

/** @param {typeof import('echarts')} echarts */
async function ensureEchartsPlatform(echarts) {
  if (runtime.echartsPlatformReady) return
  echarts.setPlatformAPI({
    createCanvas(width = 32, height = 32) {
      return /** @type {any} */ (createSkiaCanvas(width, height))
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
        return /** @type {any} */ (img)
      }

      void Promise.resolve(loadImageFromCanvas(/** @type {any} */ (src))).then(
        (loaded) => {
          const content = loaded?.src ?? loaded
          img.src = content
        },
        onerror,
      )
      return /** @type {any} */ (img)
    },
  })
  runtime.echartsPlatformReady = true
}

/** @param {FontBootstrap|undefined} fonts */
function fontKey(fonts) {
  if (!fonts?.sources?.length) return 'none'
  const normalized = fonts.sources
    .map((source) => `${source.type}:${path.resolve(source.path)}:${source.alias ?? ''}`)
    .sort()
  return normalized.join('|')
}

/** @param {FontBootstrap|undefined} fonts */
function loadFontsOnce(fonts) {
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

/** @param {FontSourcePayload} source */
function loadFontSource(source) {
  const absPath = path.resolve(source.path)
  try {
    if (source.type === 'dir') {
      GlobalFonts.loadFontsFromDir(absPath)
    } else if (source.type === 'file') {
      GlobalFonts.registerFromPath(absPath, source.alias)
    }
  } catch (err) {
    // Best effort; swallow errors to avoid failing render
    console.warn('[canvas-worker] font load failed', absPath, err)
  }
}

/**
 * @param {typeof import('echarts')} echarts
 * @param {string|undefined} dir
 */
function registerThemesFromDir(echarts, dir) {
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

/**
 * @param {Leafer} parent
 * @param {RenderNode[]} nodes
 * @param {string} fontFamily
 */
function addNodes(parent, nodes, fontFamily) {
  for (const node of nodes) {
    const instance = createNode(node, fontFamily)
    if (instance) {
      parent.add(instance)
      if (node.children?.length && 'add' in instance) {
        addNodes(/** @type {any} */ (instance), node.children, fontFamily)
      }
    }
  }
}

/**
 * @param {RenderNode} node
 * @param {string} fontFamily
 */
function createNode(node, fontFamily) {
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
        url: node.url ?? node.src,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        opacity: node.opacity,
        mode: node.mode,
      })
    case 'group':
      return new Leafer({
        width: /** @type {any} */ (node).width ?? 0,
        height: /** @type {any} */ (node).height ?? 0,
      })
    default:
      return null
  }
}

function bufferFromExport(data) {
  if (Buffer.isBuffer(data)) return data
  if (typeof data === 'string') {
    const base64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data
    return Buffer.from(base64, 'base64')
  }
  if (data && typeof data.data === 'string') return bufferFromExport(data.data)
  if (data && Buffer.isBuffer(data.data)) return data.data
  throw new Error('Unsupported export data type')
}

/**
 * @param {WorkerJob & { kind: 'leafui' }} job
 * @returns {Promise<WorkerRenderResult>}
 */
async function renderLeafui(job) {
  ensureCanvas()
  loadFontsOnce(job.fonts)
  const started = Date.now()
  const payload = job.payload
  const leafer = createLeaferFromPayload(payload)
  try {
    const exportResult = await /** @type {Leafer} */ (leafer).export('png')
    const buffer = bufferFromExport(exportResult?.data ?? exportResult)
    return {
      buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      durationMs: Date.now() - started,
      meta: { width: payload.width, height: payload.height },
    }
  } finally {
    leafer.destroy?.()
  }
}

/**
 * @param {WorkerJob & { kind: 'echarts' }} job
 * @returns {Promise<WorkerRenderResult>}
 */
async function renderEcharts(job) {
  ensureCanvas()
  const echarts = await getEcharts()
  await ensureEchartsPlatform(echarts)
  loadFontsOnce(job.fonts)

  const started = Date.now()
  const payload = job.payload
  registerThemesFromDir(echarts, payload.themesDir)

  const canvas = createSkiaCanvas(payload.width, payload.height)
  /** @type {import('echarts').EChartsOption} */
  const appliedOptions = { animation: false, ...payload.options }
  appliedOptions.textStyle = {
    fontFamily: payload.fontFamily,
    fontSize: 16,
    ...(appliedOptions.textStyle ?? {}),
  }

  const chart = echarts.init(/** @type {any} */ (canvas), payload.theme, {
    renderer: 'canvas',
    width: payload.width,
    height: payload.height,
  })
  /** @type {Buffer} */
  let buffer
  try {
    chart.setOption(appliedOptions)

    if (typeof /** @type {any} */ (canvas).toBuffer === 'function') {
      buffer = /** @type {Buffer} */ ((/** @type {any} */ (canvas)).toBuffer('image/png'))
    } else if (typeof /** @type {any} */ (canvas).encode === 'function') {
      const encoded = await /** @type {any} */ (canvas).encode('png')
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

/**
 * @param {LeaferExports} leafer
 * @param {any} tree
 */
function applyTree(leafer, tree) {
  if (!tree) return false
  if (leafer.tree && typeof leafer.tree.set === 'function') {
    try {
      leafer.tree.set(tree.children ? { children: tree.children } : tree)
      return true
    } catch (err) {
      console.warn('[canvas-worker] failed to set tree', err)
    }
  }
  return false
}

/**
 * @param {{ scene?: RenderScene; tree?: any; width: number; height: number; fontFamily: string; background?: string | null }} payload
 */
function createLeaferFromPayload(payload) {
  const { scene, tree, width, height, fontFamily, background } = payload
  /** @type {LeaferExports} */
  const leafer = /** @type {any} */ (new Leafer({ width, height }))

  if (tree && applyTree(leafer, tree)) {
    if (background) {
      leafer.add(Rect.one({ fill: background, x: 0, y: 0 }, width, height))
    }
    return leafer
  }

  if (scene?.kind === 'leafer-json') {
    const LeaferCtor = /** @type {LeaferStatic} */ (Leafer)
    if (typeof LeaferCtor.fromJSON === 'function') {
      const built = LeaferCtor.fromJSON(scene.json)
      if (built) return /** @type {LeaferExports} */ (built)
    }
    if (typeof leafer.load === 'function') {
      void leafer.load(scene.json)
    } else if (typeof leafer.import === 'function') {
      void leafer.import(scene.json)
    }
    return leafer
  }

  if (background) {
    leafer.add(Rect.one({ fill: background, x: 0, y: 0 }, width, height))
  }

  if (scene?.kind === 'nodes') {
    addNodes(leafer, scene.nodes, fontFamily)
  }
  return leafer
}

/**
 * @param {WorkerJob} job
 * @returns {Promise<WorkerRenderResult>}
 */
export default async function run(job) {
  switch (job.kind) {
    case 'leafui':
      return renderLeafui(/** @type {any} */ (job))
    case 'echarts':
      return renderEcharts(/** @type {any} */ (job))
    default:
      throw new Error(`Unknown worker job: ${/** @type {any} */ (job)?.kind}`)
  }
}
