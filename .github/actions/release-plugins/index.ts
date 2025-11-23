import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import * as core from "@actions/core";
import { exec as execCommand } from "@actions/exec";
import { glob } from "tinyglobby";
import ignoreConfig from "./ignore-patterns.json" with { type: "json" };
import turboConfigData from "./turbo.config.json" with { type: "json" };
import scriptsConfigData from "./scripts.config.json" with { type: "json" };

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_RUNTIME_DIR = ".pluxel/runtime";
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const DEFAULT_PACKAGE_ROOT_CANDIDATES = ["packages"];
const TURBO_CONFIG_FILENAME = "turbo.json";

// Load configurations from static imports
const IGNORED_COPY_SEGMENTS = new Set<string>(ignoreConfig.segments);
const TURBO_CONFIG = turboConfigData;
const SCRIPTS_CONFIG = scriptsConfigData;
const TURBO_PUBLISH_ENV_ALLOWLIST = [
	"NPM_CONFIG_REGISTRY",
	"NPM_CONFIG_PROVENANCE",
	"NODE_AUTH_TOKEN",
	"NPM_TOKEN",
	"NPM_CONFIG_USERCONFIG",
	"ACTIONS_ID_TOKEN_REQUEST_TOKEN",
	"ACTIONS_ID_TOKEN_REQUEST_URL",
];

// Type definitions
interface ActionConfig {
	workspace: string;
	basePath: string;
	runtimeDir: string;
	packageRoots: string[];
	npmRegistry: string;
	npmAccess: string;
	pnpmInstallArgs: string[];
	dryRun: boolean;
	npmProvenance: boolean;
}

interface PublishedPackage {
	name: string;
	version: string;
	path: string;
}

interface PrepareRuntimeOptions {
	basePath: string;
	workspace: string;
	runtimeDir: string;
	packageRoots: string[];
}

interface RepositoryContext {
	visibility?: string;
	isPrivate?: boolean;
	source?: string;
}

interface PackageJson {
	name?: string;
	version?: string;
	scripts?: Record<string, string>;
	[key: string]: unknown;
}

async function run(): Promise<void> {
	const config = await readConfig();

	core.info(`Using runtime workspace at ${config.runtimeDir}`);

	await core.group("Auth environment", async () => {
		logAuthEnvironment();
		core.info(`Resolved npm registry: ${config.npmRegistry}`);
		core.info(`Resolved npm provenance: ${config.npmProvenance ? "true" : "false"}`);
	});

	await prepareRuntime({
		basePath: config.basePath,
		workspace: config.workspace,
		runtimeDir: config.runtimeDir,
		packageRoots: config.packageRoots,
	});

	await core.group("Install workspace dependencies", async () => {
		// Always use --no-frozen-lockfile because runtime is dynamically generated
		// User args are appended but cannot override this requirement
		const installArgs = ["install", "--no-frozen-lockfile", ...config.pnpmInstallArgs];

		await runCommand(
			"pnpm",
			installArgs,
			config.runtimeDir,
			{
				NPM_CONFIG_REGISTRY: config.npmRegistry,
			},
		);
	});

	const published = await runPublishPipeline(config);

	core.setOutput("published-count", `${published.length}`);
	core.setOutput("published", JSON.stringify(published));

	if (published.length === 0) {
		core.info("No packages required publishing.");
	} else {
		core.info(
			`Published: ${published.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`,
		);
	}
}

async function readConfig(): Promise<ActionConfig> {
	const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
	const actionPath = process.env.GITHUB_ACTION_PATH;
	const repository = await readRepositoryContext();

	const runtimeDirInput =
		core.getInput("runtime-directory") || DEFAULT_RUNTIME_DIR;
	const packageRoots = await resolvePackageRoots(
		workspace,
		getListInput("package-roots"),
	);
	const hasPrivatePackage = await detectPrivatePackages(workspace, packageRoots);
	const provenance = decideNpmProvenance(repository, hasPrivatePackage);

	return {
		workspace,
		basePath: resolveBasePath(
			core.getInput("base-path") || undefined,
			actionPath || undefined,
		),
		runtimeDir: resolveRuntimeDir(workspace, runtimeDirInput),
		packageRoots,
		npmRegistry: normalizeRegistry(core.getInput("npm-registry")),
		npmAccess: core.getInput("npm-access") || "public",
		pnpmInstallArgs: splitArgs(
			core.getInput("pnpm-install-args") || "--frozen-lockfile",
		),
		dryRun: core.getBooleanInput("dry-run"),
		npmProvenance: provenance,
	};
}

async function readRepositoryContext(): Promise<RepositoryContext> {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) {
		core.info("GITHUB_EVENT_PATH not set; npm provenance will remain default.");
		return {};
	}

	try {
		const raw = await fs.readFile(eventPath, "utf8");
		const data = JSON.parse(raw);
		const repo = data?.repository ?? {};
		const visibility =
			typeof repo.visibility === "string"
				? repo.visibility.toLowerCase()
				: undefined;
		const isPrivate =
			typeof repo.private === "boolean"
				? repo.private
				: visibility === "private"
					? true
					: undefined;

		return { visibility, isPrivate, source: eventPath };
	} catch (error) {
		core.warning(
			`Could not read repository visibility from ${eventPath}: ${String(error)}`,
		);
		return { source: eventPath };
	}
}

async function detectPrivatePackages(workspace: string, packageRoots: string[]): Promise<boolean> {
	for (const root of packageRoots) {
		const pkgJsonPath = path.join(workspace, root, "package.json");

		if (!(await pathExists(pkgJsonPath))) {
			continue;
		}

		const pkg = await readPackageJson(pkgJsonPath);
		if (pkg?.private === true) {
			core.info(`package.json marked private: ${pkgJsonPath}`);
			return true;
		}
	}

	return false;
}

function decideNpmProvenance(repository: RepositoryContext, hasPrivatePackage: boolean): boolean {
	const visibility = repository.visibility?.toLowerCase();
	if (hasPrivatePackage) {
		core.info("Detected private package; disabling npm provenance.");
		return false;
	}

	if (visibility === "private" || visibility === "internal" || repository.isPrivate) {
		core.info("Repository is private/internal; disabling npm provenance.");
		return false;
	}

	core.info("Repository is public; enabling npm provenance.");
	return true;
}

function logAuthEnvironment(): void {
	const hasOidcUrl = Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
	const hasOidcToken = Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
	const hasNodeAuth = Boolean(process.env.NODE_AUTH_TOKEN);
	const hasNpmAuth =
		Boolean(process.env.NPM_AUTH_TOKEN) ||
		Boolean(process.env.NPM_TOKEN) ||
		Boolean(process.env.npm_config__authToken);

	core.info(`OIDC request URL: ${hasOidcUrl ? "present" : "missing"}`);
	core.info(`OIDC request token: ${hasOidcToken ? "present" : "missing"}`);
	core.info(`NODE_AUTH_TOKEN: ${hasNodeAuth ? "present" : "missing"}`);
	core.info(`NPM auth env (NPM_AUTH_TOKEN/NPM_TOKEN/npm_config__authToken): ${hasNpmAuth ? "present" : "missing"}`);
	core.info(`NPM_CONFIG_PROVENANCE: ${process.env.NPM_CONFIG_PROVENANCE ?? "(unset)"}`);
}

async function prepareRuntime(options: PrepareRuntimeOptions): Promise<void> {
	const { basePath, workspace, runtimeDir, packageRoots } = options;

	await fs.rm(runtimeDir, { recursive: true, force: true });
	await fs.mkdir(runtimeDir, { recursive: true });

	await fs.cp(basePath, runtimeDir, {
		recursive: true,
		filter: (source) => shouldCopyBaseEntry(source, basePath),
	});

	await copyWorkspaceRoot(workspace, runtimeDir, packageRoots);

	// Copy all package roots into packages/ directory for workspace consistency
	const packagesDir = path.join(runtimeDir, "packages");
	await fs.mkdir(packagesDir, { recursive: true });

	for (const relative of packageRoots) {
		const source = path.join(workspace, relative);
		// Use the last segment of the path as the package name in packages/
		const pkgName = relative === "." ? "root" : path.basename(relative);
		const target = path.join(packagesDir, pkgName);

		if (await pathExists(source)) {
			// Check if source has package.json (it should, but double-check)
			const sourcePkgJson = path.join(source, "package.json");
			if (await pathExists(sourcePkgJson)) {
				await fs.rm(target, { recursive: true, force: true });
				await fs.cp(source, target, { recursive: true });
				core.info(`Copied package from ${relative} to packages/${pkgName}`);
			} else {
				core.warning(`Skipping ${relative}: no package.json found`);
			}
		} else {
			core.warning(
				`Package root "${relative}" not found in workspace.`,
			);
		}
	}
}

function shouldCopyBaseEntry(source: string, basePath: string): boolean {
	const relative = path.relative(basePath, source);
	if (!relative || relative.startsWith("..")) {
		return true;
	}
	const segments = relative.split(path.sep);
	return !segments.some((segment) => IGNORED_COPY_SEGMENTS.has(segment));
}

async function copyWorkspaceRoot(workspace: string, runtimeDir: string, packageRoots: string[]): Promise<void> {
	const skipRoots = new Set(
		packageRoots
			.filter((root) => root !== ".")
			.map((root) => root.split(path.sep)[0]),
	);
	const entries = await fs.readdir(workspace, { withFileTypes: true });

	for (const entry of entries) {
		if (IGNORED_COPY_SEGMENTS.has(entry.name)) {
			continue;
		}
		if (skipRoots.has(entry.name)) {
			continue;
		}

		const source = path.join(workspace, entry.name);
		const target = path.join(runtimeDir, entry.name);

		await fs.rm(target, { recursive: true, force: true });
		await fs.cp(source, target, { recursive: true });
	}
}

async function runPublishPipeline(config: ActionConfig): Promise<PublishedPackage[]> {
	await ensureTurboConfig(config);
	await ensurePluxelScripts(config);

	const filters = buildPackageFilters(config.packageRoots);

	await core.group(`pnpm turbo run pluxel:build ${filters.join(" ")}`, async () => {
		await runCommand(
			"pnpm",
			["turbo", "run", "pluxel:build", ...filters, "--no-daemon"],
			config.runtimeDir,
			{
				NPM_CONFIG_REGISTRY: config.npmRegistry,
			},
		);
	});

	const publishEnv: Record<string, string | undefined> = {
		NPM_CONFIG_REGISTRY: config.npmRegistry,
	};

	if (config.npmProvenance !== undefined) {
		publishEnv.NPM_CONFIG_PROVENANCE = config.npmProvenance
			? "true"
			: "false";
	}

	const turboEnvArgs = buildTurboEnvArgs(
		publishEnv,
		TURBO_PUBLISH_ENV_ALLOWLIST,
	);

	await core.group(
		`pnpm turbo run pluxel:publish ${[...filters, ...turboEnvArgs].join(" ")}`,
		async () => {
			await runCommand(
				"pnpm",
				["turbo", "run", "pluxel:publish", ...filters, "--no-daemon", ...turboEnvArgs],
				config.runtimeDir,
				publishEnv,
			);
		},
	);

	return await collectPublishedPackages(config);
}

async function ensureTurboConfig(config: ActionConfig): Promise<void> {
	const turboPath = path.join(config.runtimeDir, TURBO_CONFIG_FILENAME);
	if (await pathExists(turboPath)) {
		return;
	}

	await fs.writeFile(turboPath, `${JSON.stringify(TURBO_CONFIG, null, 2)}\n`, "utf8");
	core.info("Using turbo config from turbo.config.json");
}

async function ensurePluxelScripts(config: ActionConfig): Promise<void> {
	for (const root of config.packageRoots) {
		// All packages are now in packages/ directory
		const pkgName = root === "." ? "root" : path.basename(root);
		const pkgJsonPath = path.join(config.runtimeDir, "packages", pkgName, "package.json");

		const pkg = await readPackageJson(pkgJsonPath);
		if (!pkg) continue;

		pkg.scripts = pkg.scripts ?? {};

		// Inject build script from static config
		pkg.scripts["pluxel:build"] = SCRIPTS_CONFIG.build;

		// Inject publish script with variable substitution
		let publishCmd = SCRIPTS_CONFIG.publish;
		publishCmd = publishCmd.replace(/\{access\}/g, config.npmAccess);

		if (config.dryRun) {
			publishCmd += " --dryRun";
		}

		pkg.scripts["pluxel:publish"] = publishCmd;

		await fs.writeFile(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
		core.info(`Injected pluxel scripts into packages/${pkgName}/package.json`);
	}
}

function buildPackageFilters(packageRoots: string[]): string[] {
	const filters: string[] = [];

	for (const root of packageRoots) {
		const pkgName = root === "." ? "root" : path.basename(root);
		filters.push("--filter", `./packages/${pkgName}`);
	}

	return filters;
}

function buildTurboEnvArgs(
	env: Record<string, string | undefined>,
	allowlist?: string[],
): string[] {
	const args: string[] = [];
	const keys = allowlist ?? Object.keys(env);

	for (const key of keys) {
		if (env[key] !== undefined) {
			args.push("--env", key);
		}
	}

	return args;
}

async function collectPublishedPackages(config: ActionConfig): Promise<PublishedPackage[]> {
	const published = [];

	for (const root of config.packageRoots) {
		const pkgName = root === "." ? "root" : path.basename(root);
		const pkgJsonPath = path.join(config.runtimeDir, "packages", pkgName, "package.json");

		const pkg = await readPackageJson(pkgJsonPath);
		if (pkg?.name && pkg?.version) {
			published.push({
				name: pkg.name,
				version: pkg.version,
				path: `packages/${pkgName}`,
			});
		}
	}

	return published;
}

async function readPackageJson(pkgPath: string): Promise<PackageJson | null> {
	try {
		const data = await fs.readFile(pkgPath, "utf8");
		return JSON.parse(data);
	} catch (error) {
		core.warning(`Could not read package.json at ${pkgPath}: ${String(error)}`);
		return null;
	}
}

async function runCommand(command: string, args: string[], cwd: string, env?: Record<string, string | undefined>): Promise<void> {
	// Resolve pnpm path for Node.js actions (they don't inherit PATH from composite actions)
	let resolvedCommand = command;
	if (command === "pnpm") {
		resolvedCommand = await resolvePnpmPath();
	}

	await execCommand(resolvedCommand, args, {
		cwd,
		env: {
			...process.env,
			...env,
		},
	});
}

async function resolvePnpmPath(): Promise<string> {
	// Try common pnpm locations in GitHub Actions
	const possiblePaths = [
		"pnpm", // If already in PATH
		"/opt/hostedtoolcache/pnpm/latest/x64/pnpm",
		path.join(process.env.PNPM_HOME || "", "pnpm"),
		path.join(process.env.HOME || "", ".local/share/pnpm/pnpm"),
	];

	for (const pnpmPath of possiblePaths) {
		try {
			// Test if this pnpm path works
			await execCommand(pnpmPath, ["--version"], {
				silent: true,
				ignoreReturnCode: true,
			});
			core.info(`Using pnpm at: ${pnpmPath}`);
			return pnpmPath;
		} catch {
			// Continue to next path
		}
	}

	// Fallback: try to use which/where command
	try {
		const { execSync } = await import("node:child_process");
		const whichCmd = process.platform === "win32" ? "where" : "which";
		const result = execSync(`${whichCmd} pnpm`, { encoding: "utf8" }).trim();
		if (result) {
			core.info(`Found pnpm via ${whichCmd}: ${result}`);
			return result.split("\n")[0]; // Use first result
		}
	} catch {
		// Ignore
	}

	core.warning("Could not find pnpm in standard locations. Trying 'pnpm' directly...");
	return "pnpm";
}

function getListInput(name: string, fallback?: string[]): string[] {
	const raw = core.getInput(name);
	if (!raw) {
		return fallback ?? [];
	}
	const tokens = raw
		.split(/[\n,]/)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	return tokens.length > 0 ? tokens : fallback ?? [];
}

function splitArgs(input: string): string[] {
	const result = [];
	let current = "";
	let quote = null;

	for (const char of input.trim()) {
		if ((char === '"' || char === "'") && !quote) {
			quote = char;
			continue;
		}
		if (char === quote) {
			quote = null;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (current.length > 0) {
				result.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (current.length > 0) {
		result.push(current);
	}

	return result;
}

function normalizeRegistry(registry: string): string {
	const base = registry && registry.length > 0 ? registry : DEFAULT_REGISTRY;
	return base.endsWith("/") ? base : `${base}/`;
}

function resolveBasePath(customPath?: string, actionPath?: string): string {
	if (customPath) {
		return path.isAbsolute(customPath)
			? customPath
			: path.resolve(customPath);
	}

	if (actionPath) {
		// action path points to .github/actions/release-plugins
		return path.resolve(actionPath, "..", "..", "..");
	}

	return path.resolve(__dirname, "..", "..", "..");
}

function resolveRuntimeDir(workspace: string, runtimeDir: string): string {
	return path.isAbsolute(runtimeDir)
		? runtimeDir
		: path.join(workspace, runtimeDir);
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

async function resolvePackageRoots(workspace: string, provided?: string[]): Promise<string[]> {
	const normalized = provided?.filter((value) => value.length > 0) ?? [];
	if (normalized.length > 0) {
		const existing = [];
		const missing = [];
		for (const root of normalized) {
			if (await pathExists(path.join(workspace, root))) {
				existing.push(root);
			} else {
				missing.push(root);
			}
		}

		if (missing.length > 0) {
			core.warning(
				`Configured package roots not found: ${missing.join(", ")}. Falling back to detected roots.`,
			);
		}

		// Special case: if the only root is "." and it doesn't have package.json,
		// automatically detect sub-packages
		if (existing.length === 1 && existing[0] === ".") {
			const rootHasPkg = await pathExists(path.join(workspace, "package.json"));
			if (!rootHasPkg) {
				core.info("Root directory has no package.json, auto-detecting sub-packages...");
				const detected = await findPackageDirs(workspace);
				if (detected.length > 0) {
					core.info(`Detected package roots: ${detected.join(", ")}`);
					return detected;
				}
			}
		}

		if (existing.length > 0) {
			return existing;
		}
	}

	const detected = await findPackageDirs(workspace);
	if (detected.length > 0) {
		core.info(`Detected package roots with package.json: ${detected.join(", ")}`);
		return detected;
	}

	const fallbacks = [];
	for (const candidate of DEFAULT_PACKAGE_ROOT_CANDIDATES) {
		if (await pathExists(path.join(workspace, candidate))) {
			fallbacks.push(candidate);
		}
	}
	if (fallbacks.length > 0) {
		core.info(`Using default package roots: ${fallbacks.join(", ")}`);
		return fallbacks;
	}

	if (await pathExists(path.join(workspace, "package.json"))) {
		core.info("No package roots provided; using workspace root (.)");
		return ["."];
	}

	core.warning("No package roots detected; publish will run from repository root.");
	return ["."];
}

async function findPackageDirs(workspace: string): Promise<string[]> {
	// Use tinyglobby to find all package.json files efficiently
	// Search up to 2 levels deep: */package.json and */*/package.json
	const packageJsonFiles = await glob(
		["*/package.json", "*/*/package.json"],
		{
			cwd: workspace,
			absolute: false,
			onlyFiles: true,
			ignore: Array.from(IGNORED_COPY_SEGMENTS).map(seg => `**/${seg}/**`),
		}
	);

	// Extract directory paths and remove package.json filename
	const roots = packageJsonFiles.map(file => path.dirname(file));

	return roots;
}

run().catch((error) => {
	core.setFailed(error instanceof Error ? error.message : String(error));
});
