import path from 'node:path'
import type { Plugin } from 'rolldown'

import {
	PACKAGE_ROOT,
	defaultManifestPath,
	mergeManifest,
	readManifest,
	type ManifestEntry,
	type ManifestFile,
	writeManifest,
} from './manifest'
import {
	formatOutDirForManifest,
	vendorFromManifest,
	vendorPackages,
	type VendorOptions,
	type VendorResult,
} from './vendor'

export interface NapiRsPluginOptions extends VendorOptions {
	manifestPath?: string
	targets?: ManifestEntry[]
	persistManifest?: boolean
}

function buildManifestEntries(results: VendorResult[], manifest: ManifestFile, cwd: string): ManifestEntry[] {
	return results.map((res) => {
		const previous = manifest.packages.find((pkg) => pkg.name === res.name)
		return {
			...previous,
			name: res.name,
			version: previous?.version ?? res.requestedVersion ?? undefined,
			resolvedVersion: res.resolvedVersion,
			tarballUrl: res.tarballUrl,
			outDir: formatOutDirForManifest(res.outDir, cwd),
			updatedAt: new Date().toISOString(),
		}
	})
}

export function napiRsVendorPlugin(options: NapiRsPluginOptions = {}): Plugin {
	const cwd = options.cwd ? path.resolve(options.cwd) : PACKAGE_ROOT
	const manifestPath = path.resolve(options.manifestPath ?? defaultManifestPath(cwd))

	return {
		name: 'napi-rs-vendor',
		async buildStart() {
			const logger = options.logger ?? console
			const manifest = (await readManifest(manifestPath, [])) as ManifestFile

			if (options.targets && options.targets.length > 0) {
				logger.log?.('[napi-rs] rolldown plugin: using inline targets')
				const results = await vendorPackages(options.targets, { ...options, cwd })

				if (options.persistManifest === false) return

				const merged = mergeManifest(
					manifest,
					buildManifestEntries(results, manifest, cwd),
					options.registry,
				)

				await writeManifest(manifestPath, merged)
				return
			}

			logger.log?.('[napi-rs] rolldown plugin: syncing manifest targets')
			await vendorFromManifest(manifestPath, { ...options, cwd })
		},
	}
}
