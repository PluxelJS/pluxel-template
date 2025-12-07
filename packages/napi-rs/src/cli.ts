#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
	defaultManifestPath,
	mergeManifest,
	readManifest,
	type ManifestFile,
	writeManifest,
} from './manifest'
import {
	formatOutDirForManifest,
	updateExportsFromManifest,
	vendorFromManifest,
	vendorPackage,
	vendorPackages,
} from './vendor'

interface ParsedArgs {
	manifestPath: string
	registry?: string
	packageSpecs?: string[]
	target?: {
		name: string
		version?: string
		outDir?: string
	}
}

function parseArgs(argv: string[]): ParsedArgs {
	let manifestPath: string | undefined
	let registry: string | undefined
	let packageSpecs: string[] = []
	const positional: string[] = []

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]
		if ((arg === '--manifest' || arg === '-m') && argv[i + 1]) {
			manifestPath = argv[i + 1]
			i += 1
			continue
		}
		if ((arg === '--registry' || arg === '-r') && argv[i + 1]) {
			registry = argv[i + 1]
			i += 1
			continue
		}
		if ((arg === '--packages' || arg === '-p') && argv[i + 1]) {
			packageSpecs = argv[i + 1]
				.split(/[,\s]+/)
				.map((s) => s.trim())
				.filter(Boolean)
			i += 1
			continue
		}
		positional.push(arg)
	}

	const [name, version, outDir] = positional
	const target = name ? { name, version, outDir } : undefined

	return {
		manifestPath: manifestPath ? path.resolve(manifestPath) : defaultManifestPath(),
		registry,
		packageSpecs,
		target,
	}
}

function parsePackageSpec(spec: string) {
	const at = spec.lastIndexOf('@')
	if (at > 0) {
		return { name: spec.slice(0, at), version: spec.slice(at + 1) || null }
	}
	return { name: spec, version: null }
}

export async function runCli(argv = process.argv.slice(2)) {
	const { manifestPath, registry, target, packageSpecs } = parseArgs(argv)
	const cwd = process.cwd()

	if (packageSpecs && packageSpecs.length > 0) {
		const inlineTargets = packageSpecs.map(parsePackageSpec)
		const manifest = (await readManifest(manifestPath, [])) as ManifestFile
		const normalizedTargets = inlineTargets.map((t) =>
			!t.version || t.version === 'latest' ? { ...t, version: null } : t,
		)
		const results = await vendorPackages(normalizedTargets, { registry, cwd })

		const manifestUpdates = results.map((res, idx) => {
			const original = normalizedTargets[idx]
			return {
				name: res.name,
				version: original.version ?? res.resolvedVersion,
				resolvedVersion: res.resolvedVersion,
				tarballUrl: res.tarballUrl,
				outDir: formatOutDirForManifest(res.outDir, cwd),
				updatedAt: new Date().toISOString(),
			}
		})

		const updated = mergeManifest(manifest, manifestUpdates, registry)
		await writeManifest(manifestPath, updated)
		await updateExportsFromManifest(updated, { cwd, enabled: true })

		console.log(`[napi-rs] vendor (inline list) -> ${manifestPath}`)
		for (const res of results) {
			console.log(` - ${res.name}@${res.resolvedVersion} -> ${res.outDir}`)
		}
		return
	}

	if (target) {
		const normalizedTarget =
			!target.version || target.version === 'latest'
				? { ...target, version: null }
				: target

		const result = await vendorPackage(normalizedTarget, { registry, cwd })
		const manifest = (await readManifest(manifestPath, [])) as ManifestFile

		const versionForManifest =
			normalizedTarget.version && normalizedTarget.version !== 'latest'
				? normalizedTarget.version
				: result.resolvedVersion

		const updated = mergeManifest(
			manifest,
			[
				{
					name: result.name,
					version: versionForManifest,
					resolvedVersion: result.resolvedVersion,
					tarballUrl: result.tarballUrl,
					outDir: formatOutDirForManifest(result.outDir, cwd),
					updatedAt: new Date().toISOString(),
				},
			],
			registry,
		)

		await writeManifest(manifestPath, updated)
		await updateExportsFromManifest(updated, { cwd, enabled: true })

		console.log(` - ${result.name}@${result.resolvedVersion} -> ${result.outDir}`)
		console.log(`[napi-rs] updated manifest: ${manifestPath}`)
		return
	}

	const { manifest, manifestPath: resolvedManifestPath, results } = await vendorFromManifest(manifestPath, {
		registry,
		cwd,
	})

	console.log(`[napi-rs] vendor done -> ${resolvedManifestPath}`)
	for (const res of results) {
		console.log(` - ${res.name}@${res.resolvedVersion} -> ${res.outDir}`)
	}

	console.log(
		`[napi-rs] tracked packages: ${manifest.packages.map((pkg) => `${pkg.name}@${pkg.resolvedVersion || pkg.version || 'latest'}`).join(', ')}`,
	)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
	runCli().catch((err) => {
		console.error('[napi-rs] vendor failed')
		console.error(err)
		process.exitCode = 1
	})
}
