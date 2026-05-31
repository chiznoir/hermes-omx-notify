#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${NODE:-node}" "$script_dir/install-codex-hooks.mjs" "$@"
