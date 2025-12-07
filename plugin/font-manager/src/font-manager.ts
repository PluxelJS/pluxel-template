import fs from 'node:fs'
import path from 'node:path'
import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { RpcTarget } from '@pluxel/hmr/capnweb'
import { v } from '@pluxel/hmr/config'
import { Collection } from '@pluxel/hmr/signaldb'
import type { SseChannel } from '@pluxel/hmr/services'
import { GlobalFonts } from 'pluxel-plugin-napi-rs/canvas'

const DEFAULT_ALIASES: Record<string, string> = {
  default: 'sans',
  body: 'sans',
  heading: 'serif',
  code: 'mono',
}
const DEFAULT_STATUS_ROUTE = process.env.FONT_MANAGER_STATUS_ROUTE ?? '/api/fonts/status'
const FIXED_FONTS_DIR = path.join(process.cwd(), 'fonts')
const EXTRA_FONT_DIRS = ['/run/host/fonts', '/usr/share/fonts', '/usr/local/share/fonts']
const FALLBACK_STACK = ['sans-serif']

const CfgSchema = v.object({
  fontDirs: v.optional(v.array(v.string()), []),
})

type PluginConfig = Config<typeof CfgSchema>
type FontSourceType = 'dir' | 'file'
type FontOrigin = 'config' | 'user' | 'system'
type FontStatus = 'ok' | 'skipped' | 'error'

type FontLoadResult = {
  id: string
  type: FontSourceType | 'system'
  origin: FontOrigin
  path?: string
  alias?: string
  count?: number
  status: FontStatus
  message?: string
  loadedAt: number
}

type FontActivity = {
  id: string
  action: 'reload' | 'add' | 'remove'
  detail: string
  at: number
}

type FontPreference = {
  id: string
  families: string[]
  updatedAt: number
}

export type FontSnapshot = {
  stack: string[]
  primary: string
  families: typeof GlobalFonts.families
  sources: FontLoadResult[]
  lastLoadedAt: number
  resolved: Record<string, string[]>
  aliases: Record<string, string>
}

@Plugin({ name: 'FontManager', type: 'service' })
export class FontManager extends BasePlugin {
  @Config(CfgSchema)
  private config!: PluginConfig

  private activity!: Collection<FontActivity, string, FontActivity>
  private preferences!: Collection<FontPreference, string, FontPreference>
  private activitySeq = 1
  private preferencesMap = new Map<string, string[]>()
  private lastLoads: FontLoadResult[] = []
  private lastLoadedAt = 0

  override async init(): Promise<void> {
    await this.initData()
    this.registerUiExtensionIfPresent()
    this.ctx.rpc.registerExtension(() => new FontManagerRpc(this))
    this.ctx.sse.registerExtension(() => this.createSseHandler())
    this.registerStatusRoute()
    await this.reloadFonts('init')
    this.ctx.logger.info('[FontManager] ready')
  }

  override async stop(): Promise<void> {
    this.ctx.logger.info('[FontManager] stopped')
  }

  async reloadFonts(reason = 'manual'): Promise<FontSnapshot> {
    await this.refreshPreferencesFromStore()
    const now = Date.now()
    const loadedPaths = new Set<string>()
    const results: FontLoadResult[] = []

    results.push({
      id: 'system',
      type: 'system',
      origin: 'system',
      count: GlobalFonts.families.length,
      status: 'ok',
      loadedAt: now,
      message: 'System fonts preloaded by canvas backend',
    })

    if (fs.existsSync(FIXED_FONTS_DIR)) {
      results.push(this.loadDir(FIXED_FONTS_DIR, 'config', loadedPaths, now))
    } else {
      results.push({
        id: `config:dir:${FIXED_FONTS_DIR}`,
        type: 'dir',
        origin: 'config',
        path: FIXED_FONTS_DIR,
        status: 'skipped',
        message: 'fonts 目录未找到，跳过',
        loadedAt: now,
      })
    }

    const candidateDirs = [...EXTRA_FONT_DIRS, ...(this.config.fontDirs ?? [])]
    for (const dir of new Set(candidateDirs)) {
      if (!dir || dir === FIXED_FONTS_DIR) continue
      results.push(this.loadDir(dir, 'config', loadedPaths, now))
    }

    this.lastLoads = results
    this.lastLoadedAt = now
    await this.recordActivity({ action: 'reload', detail: `Reloaded fonts (${reason})`, at: now })

    return this.buildSnapshot()
  }

  getFontStack(key = 'sans', extra: string[] = []): string[] {
    const category = this.resolveAlias(key)
    const prefs = this.preferencesMap.get(category) ?? []
    const stack = [...extra, ...prefs, ...FALLBACK_STACK]
    const seen = new Set<string>()
    return stack
      .map((name) => name.trim())
      .filter((name) => {
        if (!name || seen.has(name)) return false
        seen.add(name)
        return true
      })
  }

  getFontFamilyString(key = 'sans', extra: string[] = []): string {
    return this.getFontStack(key, extra)
      .map((name) => (/[\s"]/u.test(name) ? `"${name.replaceAll('"', '\\"')}"` : name))
      .join(', ')
  }

  getPrimaryFont(key = 'sans'): string {
    return this.getFontStack(key)[0] ?? 'sans-serif'
  }

  resolveFontFamily(preferred: string | undefined, key = 'sans') {
    if (preferred) {
      const first = preferred.split(',')[0]?.replaceAll(/["']/g, '').trim()
      const normalizedKey = this.resolveAlias(key)
      if (this.preferencesMap.get(normalizedKey)?.includes(first)) {
        return preferred
      }
      if (!first || GlobalFonts.has(first) || first.toLowerCase().includes('sans') || first.toLowerCase().includes('serif')) {
        return preferred
      }
    }
    return this.getFontFamilyString(key)
  }

  getResolvedStacks(keys?: string[]): Record<string, string[]> {
    const aliasMap = this.getAliasMap()
    const preferenceKeys = Array.from(this.preferencesMap.keys())
    const baseKeys = keys?.length
      ? keys
      : ['sans', 'serif', 'mono', 'fallback', ...Object.keys(aliasMap), ...preferenceKeys]
    const resolved: Record<string, string[]> = {}
    for (const key of new Set(baseKeys)) {
      resolved[key] = this.getFontStack(key)
    }
    return resolved
  }

  buildSnapshot(): FontSnapshot {
    const families = GlobalFonts.families
    const aliasMap = this.getAliasMap()
    return {
      stack: this.getFontStack(),
      primary: this.getPrimaryFont(),
      families,
      sources: this.lastLoads,
      lastLoadedAt: this.lastLoadedAt,
      resolved: this.getResolvedStacks(),
      aliases: aliasMap,
    }
  }

  private async initData() {
    this.activity = new Collection<FontActivity, string, FontActivity>({
      name: 'font-activity',
      persistence: await this.ctx.pluginData.persistenceForCollection<FontActivity>('font-activity'),
    })
    this.preferences = new Collection<FontPreference, string, FontPreference>({
      name: 'font-preferences',
      persistence: await this.ctx.pluginData.persistenceForCollection<FontPreference>('font-preferences'),
    })

    const [activityDocs, preferenceDocs] = await Promise.all([
      this.activity.find(),
      this.preferences.find(),
    ])
    const activities = activityDocs.map((item) => ({ ...item }))
    this.applyPreferences(preferenceDocs.map((item) => ({ ...item })))

    this.activitySeq = activities.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  }

  private createSseHandler() {
    return (channel: SseChannel) => {
      const sendSnapshot = async () => channel.emit('sync', { type: 'sync', snapshot: await this.getSnapshot('sse') })
      void sendSnapshot()

      const activityCursor = this.activity.find({}, { sort: { at: -1 }, limit: 32 })
      const preferencesCursor = this.preferences.find({})
      const onChange = () => {
        void sendSnapshot()
      }

      const stopActivity = activityCursor.observeChanges(
        {
          added: onChange,
          changed: onChange,
          removed: onChange,
        },
        true,
      )
      const stopPreferences = preferencesCursor.observeChanges(
        {
          added: onChange,
          changed: onChange,
          removed: onChange,
        },
        true,
      )

      channel.onAbort(() => {
        stopActivity?.()
        stopPreferences?.()
      })

      return () => {
        stopActivity?.()
        stopPreferences?.()
      }
    }
  }

  private registerStatusRoute() {
    if (!DEFAULT_STATUS_ROUTE) return
    const route = DEFAULT_STATUS_ROUTE
    this.ctx.honoService.modifyApp((app) => {
      app.get(route, async (c) => {
        const snapshot = await this.getSnapshot('route')
        return c.json(snapshot)
      })
    })
  }

  private registerUiExtensionIfPresent() {
    this.ctx.extensionService.register({
      entryPath: './ui/index.tsx',
    })
  }

  private loadDir(dirPath: string, origin: FontOrigin, loadedPaths: Set<string>, now: number, alias?: string): FontLoadResult {
    const absPath = this.normalizePath(dirPath)
    if (loadedPaths.has(absPath)) {
      return {
        id: `${origin}:dir:${absPath}`,
        type: 'dir',
        origin,
        path: absPath,
        alias,
        status: 'skipped',
        message: 'Already loaded in this cycle',
        loadedAt: now,
      }
    }

    loadedPaths.add(absPath)

    try {
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
        return {
          id: `${origin}:dir:${absPath}`,
          type: 'dir',
          origin,
          path: absPath,
          alias,
          status: 'error',
          message: 'Directory not found',
          loadedAt: now,
        }
      }

      const count = GlobalFonts.loadFontsFromDir(absPath)
      this.ctx.logger.debug(`[FontManager] Loaded ${count} fonts from dir: ${absPath}`)
      return {
        id: `${origin}:dir:${absPath}`,
        type: 'dir',
        origin,
        path: absPath,
        alias,
        count,
        status: count > 0 ? 'ok' : 'skipped',
        message: count > 0 ? undefined : 'No font files found',
        loadedAt: now,
      }
    } catch (err) {
      return {
        id: `${origin}:dir:${absPath}`,
        type: 'dir',
        origin,
        path: absPath,
        alias,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        loadedAt: now,
      }
    }
  }

  private loadFile(
    filePath: string,
    alias: string | undefined,
    origin: FontOrigin,
    loadedPaths: Set<string>,
    now: number,
  ): FontLoadResult {
    const absPath = this.normalizePath(filePath)
    if (loadedPaths.has(absPath)) {
      return {
        id: `${origin}:file:${absPath}`,
        type: 'file',
        origin,
        path: absPath,
        alias,
        status: 'skipped',
        message: 'Already loaded in this cycle',
        loadedAt: now,
      }
    }

    loadedPaths.add(absPath)

    try {
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        return {
          id: `${origin}:file:${absPath}`,
          type: 'file',
          origin,
          path: absPath,
          alias,
          status: 'error',
          message: 'File not found',
          loadedAt: now,
        }
      }

      const ok = GlobalFonts.registerFromPath(absPath, alias)
      this.ctx.logger.debug(
        ok ? `[FontManager] Font registered: ${absPath}${alias ? ` as ${alias}` : ''}` : '[FontManager] Font skipped',
      )

      return {
        id: `${origin}:file:${absPath}`,
        type: 'file',
        origin,
        path: absPath,
        alias,
        count: ok ? 1 : 0,
        status: ok ? 'ok' : 'skipped',
        message: ok ? undefined : 'registerFromPath returned false',
        loadedAt: now,
      }
    } catch (err) {
      return {
        id: `${origin}:file:${absPath}`,
        type: 'file',
        origin,
        path: absPath,
        alias,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        loadedAt: now,
      }
    }
  }

  async setPreferredFamilies(key: string, families: string[]) {
    const normalizedKey = this.resolveAlias(key)
    const list = families.map((f) => f.trim()).filter(Boolean)
    if (list.length === 0) {
      this.preferencesMap.delete(normalizedKey)
      const existing = this.preferences.findOne({ id: normalizedKey })
      if (existing) {
        await this.preferences.removeOne({ id: normalizedKey })
      }
    } else {
      this.preferencesMap.set(normalizedKey, list)
      const existing = this.preferences.findOne({ id: normalizedKey })
      if (existing) {
        this.preferences.updateOne({ id: normalizedKey }, { $set: { families: list, updatedAt: Date.now() } })
      } else {
        await this.preferences.insert({ id: normalizedKey, families: list, updatedAt: Date.now() })
      }
    }
    return { key: normalizedKey, families: list }
  }

  private resolveAlias(key?: string) {
    if (!key) return 'sans'
    const alias = this.getAliasMap()
    return alias[key] ?? key
  }

  private getAliasMap() {
    return DEFAULT_ALIASES
  }

  async getSnapshot(reason?: string) {
    await this.refreshPreferencesFromStore()
    if (!this.lastLoadedAt) {
      await this.reloadFonts(reason ?? 'snapshot')
    }
    return this.buildSnapshot()
  }

  private applyPreferences(prefs: FontPreference[]) {
    this.preferencesMap.clear()
    for (const pref of prefs) {
      this.preferencesMap.set(pref.id, (pref.families ?? []).map((f) => f.trim()).filter(Boolean))
    }
  }

  private async refreshPreferencesFromStore() {
    const prefs = await this.preferences.find()
    this.applyPreferences(prefs.map((p) => ({ ...p })))
  }

  private normalizePath(target: string) {
    const root = process.cwd()
    return path.isAbsolute(target) ? path.normalize(target) : path.resolve(root, target)
  }

  private async recordActivity(entry: Omit<FontActivity, 'id'>) {
    const activity: FontActivity = {
      id: String(this.activitySeq++),
      ...entry,
    }
    await this.activity.insert(activity)

    const items = await this.activity.find()
    if (items.count() > 48) {
      const sorted = items
        .map((item) => item)
        .sort((a, b) => a.at - b.at)
        .slice(0, items.count() - 32)
      for (const old of sorted) {
        this.activity.removeOne({ id: old.id })
      }
    }
  }
}

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

export default FontManager

declare module '@pluxel/hmr/services' {
  interface RpcExtensions {
    FontManager: FontManagerRpc
  }

  interface SseEvents {
    FontManager: { type: 'sync'; snapshot: FontSnapshot }
  }
}
