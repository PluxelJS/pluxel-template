#!/usr/bin/env sh
set -eu

template_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
workspace_dir="$(CDPATH= cd -- "$template_dir/.." && pwd)"

cmd="${1:-}"
shift || true

product_dir="${1:-}"
if [ -n "$product_dir" ]; then
	shift || true
else
	product_dir="$(pwd)"
fi

usage() {
	cat <<'EOF'
Usage:
  sh ../pluxel-template/scripts/workspace.sh <command> [product_dir]

Commands:
  link-vendor       Create thin vendor symlink tree (packages/plugins/agents).
  bootstrap-product Link vendor, build upstream pluxel dist, then pnpm install in product.
EOF
}

ensure_workspace_layout() {
	product_abs="$(CDPATH= cd -- "$product_dir" && pwd)"
	product_parent="$(CDPATH= cd -- "$product_abs/.." && pwd)"

	if [ "$product_parent" != "$workspace_dir" ]; then
		echo "[workspace] expected product repo to be a sibling of pluxel-template under: $workspace_dir" >&2
		echo "[workspace] got: $product_abs" >&2
		exit 2
	fi
}

link_vendor() {
	ensure_workspace_layout

	product_abs="$(CDPATH= cd -- "$product_dir" && pwd)"
	vendor_root="$product_abs/vendor/pluxel-template"

	mkdir -p "$vendor_root"

	# If old "single symlink" exists, remove it.
	if [ -L "$vendor_root" ]; then
		rm -f "$vendor_root"
		mkdir -p "$vendor_root"
	fi

	# Keep vendor thin and relocatable: use paths relative to vendor_root.
	ln -sfn "../../../pluxel-template/packages" "$vendor_root/packages"
	ln -sfn "../../../pluxel-template/plugins" "$vendor_root/plugins"
	ln -sfn "../../../pluxel-template/AGENTS.md" "$vendor_root/AGENTS.md"
	ln -sfn "../../../pluxel-template/agents" "$vendor_root/agents"

	echo "[workspace] linked vendor in $(basename "$product_abs")"
}

bootstrap_product() {
	command -v pnpm >/dev/null 2>&1 || {
		echo "[workspace] pnpm not found in PATH" >&2
		exit 127
	}

	link_vendor

	if [ ! -d "$workspace_dir/pluxel/packages/hmr" ]; then
		echo "[workspace] missing pluxel repo at $workspace_dir/pluxel" >&2
		exit 2
	fi

	# Template may contain upstream submodules (optional).
	if [ -f "$template_dir/.gitmodules" ]; then
		git -C "$template_dir" submodule update --init --recursive
	fi

	echo "[workspace] build upstream dist outputs (pluxel)"
	pnpm -C "$workspace_dir/pluxel" install
	pnpm -C "$workspace_dir/pluxel" --filter @pluxel/core --filter @pluxel/hmr --filter @pluxel/test build

	echo "[workspace] install product workspace"
	pnpm -C "$product_dir" install

	echo "[workspace] ok"
}

case "$cmd" in
	link-vendor)
		link_vendor
		;;
	bootstrap-product)
		bootstrap_product
		;;
	-h|--help|"")
		usage
		exit 0
		;;
	*)
		echo "[workspace] unknown command: $cmd" >&2
		usage >&2
		exit 2
		;;
esac
