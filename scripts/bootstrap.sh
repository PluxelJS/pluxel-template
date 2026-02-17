#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
pluxel_dir="$repo_dir/../pluxel"

command -v pnpm >/dev/null 2>&1 || {
	echo "[bootstrap] pnpm not found in PATH" >&2
	exit 127
}

if [ ! -d "$pluxel_dir/packages/hmr" ]; then
	echo "[bootstrap] missing $pluxel_dir (place Pluxel repo at ../pluxel)" >&2
	exit 2
fi

if [ -f "$repo_dir/.gitmodules" ]; then
	git -C "$repo_dir" submodule update --init --recursive
fi

# Ensure upstream packages have `dist/` outputs for Node (HMR host runs compiled JS).
pnpm -C "$pluxel_dir" install
pnpm -C "$pluxel_dir" --filter @pluxel/core --filter @pluxel/hmr --filter @pluxel/test build

pnpm -C "$repo_dir" install
