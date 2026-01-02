import type { LeaferTree } from './types'

type LeaferLike = {
  tree?: {
    export?: (format?: string) => any
    set?: (data: any) => void
    toJSON?: () => any
  }
  export?: (format?: string) => any
  toJSON?: () => any
}

export function exportTree(app: LeaferLike, format = 'json'): LeaferTree {
  if (!app) throw new Error('exportTree: missing Leafer app')
  const candidates = [
    () => (app.tree && typeof app.tree.export === 'function' ? app.tree.export(format) : undefined),
    () => (typeof app.export === 'function' ? app.export(format) : undefined),
    () => (app.tree && typeof app.tree.toJSON === 'function' ? app.tree.toJSON() : undefined),
    () => (typeof app.toJSON === 'function' ? app.toJSON() : undefined),
  ]

  for (const get of candidates) {
    const data = get()
    if (data) return data as LeaferTree
  }

  throw new Error('exportTree: provided object does not support export')
}

export function tryExportTree(app: LeaferLike | null | undefined, format = 'json'): LeaferTree | null {
  try {
    return app ? exportTree(app, format) : null
  } catch {
    return null
  }
}
