#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-}"
if [ -z "${repo_root}" ]; then
  if [ -f "./packages/core/src/logger/LogUsage.md" ]; then
    repo_root="."
  else
    # Try a sibling checkout (template setups often keep Pluxel beside the template).
    for candidate in ../*; do
      if [ -f "${candidate}/packages/core/src/logger/LogUsage.md" ]; then
        repo_root="${candidate}"
        break
      fi
    done
    if [ -z "${repo_root}" ]; then
      echo "Missing source file. Pass <pluxel-repo-root> explicitly." >&2
      exit 2
    fi
  fi
fi

src="$repo_root/packages/core/src/logger/LogUsage.md"
dst="$(cd "$(dirname "$0")/.." && pwd)/references/logusage.full.md"

if [ ! -f "$src" ]; then
  echo "Missing source file: $src" >&2
  exit 2
fi

mkdir -p "$(dirname "$dst")"

cat >"$dst" <<EOF
<!--
Synced snapshot for project-local skill usage.
Source: upstream packages/core/src/logger/LogUsage.md
If this diverges from repo behavior, prefer the repo source of truth and re-sync.
-->

EOF

cat "$src" >>"$dst"

echo "Synced: $src -> $dst"
