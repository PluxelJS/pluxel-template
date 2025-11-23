# Pluxel Release Action

This action hydrates the Pluxel runtime and publishes plugins to npm.

## Usage

### Basic Usage (Auto-detection)

For repositories with sub-packages (no root package.json):

```yaml
- uses: PluxelJS/pluxel-template/.github/actions/release-plugins@main
  with:
    package-roots: .
```

The action will automatically detect sub-packages like:
```
chatbots/
  ├── kook/package.json       # Auto-detected
  └── wretch/package.json     # Auto-detected
```

### Explicit Package Roots

For explicit control:

```yaml
- uses: PluxelJS/pluxel-template/.github/actions/release-plugins@main
  with:
    package-roots: kook,wretch
```

## Configuration Files

### `scripts.config.json`

Defines the build and publish commands injected into each package's `package.json`.

**When to modify:**
- Change build command (e.g., use different flags, different tool)
- Change publish command (e.g., use npm publish instead of pluxel)
- Add custom pre/post processing steps

**Default configuration:**
```json
{
  "build": "pluxel build --debug",
  "publish": "npm publish --access {access} --verbose --provenance"
}
```

**Available placeholders:**
- `{access}` - Replaced with npm-access input (default: public)

**Note:** `pluxel publish` no longer requires `--root` or `--registry` parameters. Registry configuration is handled via `.npmrc` and environment variables.

**Example with pluxel publish:**
```json
{
  "build": "pluxel build",
  "publish": "pluxel publish --access {access}"
}
```

### `ignore-patterns.json`

Defines which files and directories to ignore when copying from the caller workspace to the runtime directory.

**When to modify:**
- Add new build artifacts to ignore
- Add framework-specific directories (e.g., `.vite`, `.astro`)
- Add temporary directories that shouldn't be copied

**Example:**
```json
{
  "segments": [
    ".git",
    ".github",
    "node_modules",
    "turbo.json",
    "turbo.jsonc"
  ]
}
```

### `turbo.config.json`

Defines the Turborepo pipeline configuration for the release build and publish.

**When to modify:**
- Change build task dependencies
- Add new tasks to the pipeline
- Modify cache behavior
- Update output patterns

**Example:**
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "pluxel:build": {
      "cache": true,
      "outputs": ["dist/**"]
    },
    "pluxel:publish": {
      "dependsOn": ["pluxel:build"],
      "cache": true,
      "outputs": []
    }
  }
}
```

### Build/Publish Pipeline

- Build: `pnpm turbo run pluxel:build --filter ./packages/<pkg> --no-daemon` (Turbo cache on)
- Publish: `pnpm turbo run pluxel:publish --filter ./packages/<pkg> --no-daemon --env ...` (Turbo cache off)
- The action forwards registry/provenance/auth/OIDC env vars via `--env` (NPM registry/provenance, NODE_AUTH/NPM_TOKEN, userconfig, OIDC token/url) so npm can read them inside Turbo workers.

Filters are derived from detected `package-roots`, so only the intended packages build and publish.

## Development

After modifying any configuration:

```bash
# Rebuild the action
pnpm run build

# Commit changes
git add .
git commit -m "chore: update release-plugins config"
```

## Architecture

```
caller-workspace/     # Your chatbots repo
    └── chatbots/
        ├── kook/
        │   └── package.json
        └── wretch/
            └── package.json

↓ hydrate into ↓

.pluxel/runtime/      # Merged runtime
    ├── package.json  # From pluxel-template (workspace root)
    ├── pnpm-workspace.yaml  # Defines packages/** as workspace
    ├── turbo.json    # Generated from turbo.config.json
    ├── packages/     # All packages go here for workspace consistency
    │   ├── kook/     # Copied and scripts injected
    │   │   └── package.json (with pluxel:build, pluxel:publish)
    │   └── wretch/   # Copied and scripts injected
    │       └── package.json (with pluxel:build, pluxel:publish)
    └── ...           # Other pluxel-template files
```

**Key Points:**
- All detected packages are copied to `runtime/packages/` directory
- This ensures pnpm installs their dependencies (via workspace)
- Build and publish run via Turbo; publish is uncached and forwards required env vars
- Package names use the basename of the original path (e.g., `kook` from `chatbots/kook`)

Files matching patterns in `ignore-patterns.json` are excluded during the copy phase.

## Package Root Detection Logic

1. **Explicit roots provided** → Check if they exist
   - If `package-roots: .` and root has no package.json → Auto-detect sub-packages
   - Otherwise use the provided roots
2. **No roots provided** → Auto-detect by scanning for package.json files (max depth: 2)
3. **Fallback** → Try default candidates (`packages/`)
4. **Final fallback** → Use root directory (`.`)
