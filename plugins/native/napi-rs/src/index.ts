export {
	defaultManifestPath,
	mergeManifest,
	readManifest,
	type ManifestEntry,
	type ManifestFile,
	type VendorTarget,
	writeManifest,
} from './manifest'
export {
	formatOutDirForManifest,
	renderGeneratedBindingEsmWrapper,
	renderGeneratedBindingJs,
	sanitizeForPath,
	vendorFromManifest,
	vendorPackage,
	vendorPackages,
	updateExportsFromManifest,
	type VendorOptions,
	type VendorResult,
} from './vendor'
