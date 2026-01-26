export type PermissionEffect = 'allow' | 'deny'

export type PermissionMeta = {
	description?: string
	tags?: string[]
	hidden?: boolean
	deprecated?: boolean
}

export type PermissionDecl = { kind: 'exact' | 'star'; local: string; default: PermissionEffect } & PermissionMeta

export const normalizeLocalId = (localId: string): string =>
	String(localId ?? '')
		.trim()
		.replace(/^\.+/g, '')
		.replace(/\.+/g, '.')
		.replace(/\.$/g, '')

export const deriveGroupFromLocalId = (localId: string): string | undefined => {
	const s = normalizeLocalId(localId)
	const dot = s.indexOf('.')
	if (dot <= 0) return undefined
	const g = s.slice(0, dot).trim()
	return g || undefined
}

export const cmdPermLocal = (localId: string): string => {
	const id = normalizeLocalId(localId)
	return id ? `cmd.${id}` : 'cmd'
}

export const cmdPermNode = (nsKey: string, local: string): string => {
	const ns = String(nsKey ?? '').trim()
	const l = String(local ?? '').trim().replace(/^\.+/g, '').replace(/\.+/g, '.').replace(/\.$/g, '')
	return ns && l ? `${ns}.${l}` : ns ? ns : l
}

export type CmdPermCatalogOptions = {
	/** Default effect for per-command exact nodes. Default: `deny`. */
	defaultEffect?: PermissionEffect
	/** Include `cmd.*` and `cmd.<group>.*` stars. Default: true. */
	includeStars?: boolean
	/** Description for `cmd.*`. */
	allDescription?: string
}

export const buildCmdPermCatalog = (
	localIds: readonly string[],
	opts: CmdPermCatalogOptions = {},
): { exact: PermissionDecl[]; stars: PermissionDecl[] } => {
	const defaultEffect = opts.defaultEffect ?? 'deny'
	const includeStars = opts.includeStars ?? true

	const seen = new Set<string>()
	const exact: PermissionDecl[] = []
	const groups = new Set<string>()

	for (const raw of localIds) {
		const id = normalizeLocalId(raw)
		if (!id) continue
		if (seen.has(id)) continue
		seen.add(id)
		const group = deriveGroupFromLocalId(id)
		if (group) groups.add(group)
		exact.push({ kind: 'exact', local: cmdPermLocal(id), default: defaultEffect })
	}

	const stars: PermissionDecl[] = []
	if (includeStars) {
		stars.push({
			kind: 'star',
			local: 'cmd',
			default: 'deny',
			description: opts.allDescription ?? 'All commands',
		})
		for (const g of Array.from(groups).sort((a, b) => a.localeCompare(b))) {
			stars.push({ kind: 'star', local: `cmd.${g}`, default: 'deny', description: `${g} commands` })
		}
	}

	return { exact, stars }
}

