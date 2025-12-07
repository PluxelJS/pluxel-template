import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

export interface VendorTarget {
	name: string
	version?: string | null
	outDir?: string
}

export interface ManifestEntry extends VendorTarget {
	resolvedVersion?: string
	tarballUrl?: string
	updatedAt?: string
}

export interface ManifestFile {
	registry?: string
	packages: ManifestEntry[]
	generatedAt?: string
}

export function defaultManifestPath(cwd: string = PACKAGE_ROOT): string {
	return path.resolve(cwd, 'vendor.manifest.json')
}

export async function readManifest(
	manifestPath: string,
	fallback: ManifestEntry[] = [],
): Promise<ManifestFile> {
	try {
		const raw = await fs.readFile(manifestPath, 'utf8')
		const parsed = JSON.parse(raw) as ManifestFile
		if (!Array.isArray(parsed.packages)) {
			throw new Error('Invalid manifest: packages is not an array')
		}
		return parsed
	} catch (err: unknown) {
		const code = (err as { code?: string })?.code
		if (code !== 'ENOENT') {
			throw err
		}
		return {
			packages: fallback,
		}
	}
}

export function mergeManifest(
	existing: ManifestFile | null,
	updates: ManifestEntry[],
	registry?: string,
): ManifestFile {
	const merged = new Map<string, ManifestEntry>()

	for (const pkg of existing?.packages ?? []) {
		merged.set(pkg.name, { ...pkg })
	}

	for (const update of updates) {
		const prev = merged.get(update.name) ?? {}
		merged.set(update.name, { ...prev, ...update })
	}

	return {
		registry: registry ?? existing?.registry,
		packages: Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name)),
		generatedAt: new Date().toISOString(),
	}
}

export async function writeManifest(manifestPath: string, manifest: ManifestFile): Promise<void> {
	await fs.mkdir(path.dirname(manifestPath), { recursive: true })
	await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}
