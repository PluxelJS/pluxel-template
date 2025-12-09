import type { Leafer } from '@leafer-ui/node'
import type { Buffer } from 'node:buffer'
import type * as echarts from 'echarts'

export type RenderNodeType = 'rect' | 'text' | 'image' | 'group'

export type RenderNode =
  | ({ type: 'rect' } & NodeBase & RectProps)
  | ({ type: 'text' } & NodeBase & TextProps)
  | ({ type: 'image' } & NodeBase & ImageProps)
  | ({ type: 'group' } & NodeBase & { children: RenderNode[] })

export interface NodeBase {
  id?: string
  name?: string
  children?: RenderNode[]
}

export interface RectProps {
  width: number
  height: number
  x?: number
  y?: number
  fill?: string
  cornerRadius?: number | number[]
  opacity?: number
  stroke?: string
  strokeWidth?: number
}

export interface TextProps {
  text: string
  x?: number
  y?: number
  fill?: string
  fontSize?: number
  fontWeight?: string | number
  textAlign?: 'left' | 'center' | 'right'
  maxWidth?: number
}

export interface ImageProps {
  url?: string
  src?: string
  x?: number
  y?: number
  width?: number
  height?: number
  opacity?: number
  mode?: any
}

export type RenderScene =
  | { kind: 'nodes'; nodes: RenderNode[] }
  | { kind: 'leafer-json'; json: unknown }

export type LeaferTree = { children?: any[]; [key: string]: any }

export interface LeafRenderPayload {
  width: number
  height: number
  background?: string | null
  fontFamily: string
  scene?: RenderScene
  tree?: LeaferTree
}

export interface LeafRenderOptions {
  width?: number
  height?: number
  background?: string | null
  fontFamily?: string
  fontKey?: string
}

export interface EchartsRenderPayload {
  width: number
  height: number
  theme: string
  fontFamily: string
  options: echarts.EChartsOption
  themesDir?: string
}

export interface RenderResultMeta {
  width: number
  height: number
}

export interface WorkerRenderResult {
  buffer: ArrayBuffer
  durationMs: number
  meta: RenderResultMeta
}

export type WorkerJob =
  | { kind: 'leafui'; payload: LeafRenderPayload; fonts?: FontBootstrap }
  | { kind: 'echarts'; payload: EchartsRenderPayload; fonts?: FontBootstrap }

export type WorkerResult = WorkerRenderResult

export interface RenderedImage {
  buffer: Buffer
  durationMs: number
  meta: RenderResultMeta
  mime: string
  dataURL?: string
}

export interface LeafRenderRequest extends LeafRenderOptions {
  scene?: RenderScene
  tree?: LeaferTree
  nodes?: RenderNode[]
  returnDataURL?: boolean
}

export interface EchartsRenderRequest {
  options: echarts.EChartsOption
  width?: number
  height?: number
  theme?: string
  fontFamily?: string
  fontKey?: string
  themesDir?: string
  returnDataURL?: boolean
}

export type LeaferExports = Leafer & {
  load?: (json: unknown) => void | Promise<void>
  import?: (json: unknown) => void | Promise<void>
}

export type LeaferStatic = typeof Leafer & {
  fromJSON?: (json: unknown) => Leafer
}

export interface FontSourcePayload {
  path: string
  alias?: string
  type: 'dir' | 'file'
}

export interface FontBootstrap {
  sources: FontSourcePayload[]
}
