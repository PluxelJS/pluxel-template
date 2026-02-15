#!/usr/bin/env sh
set -eu

if [ ! -d "../pluxel/packages/hmr" ]; then
	echo "Missing ../pluxel. Place the Pluxel repo at ../pluxel (sibling directory) first."
	exit 1
fi

git submodule update --init --recursive

# Ensure upstream packages have `dist/` outputs for Node (HMR host runs compiled JS).
pnpm -C ../pluxel install
pnpm -C ../pluxel --filter @pluxel/core --filter @pluxel/hmr --filter @pluxel/test build

pnpm install
