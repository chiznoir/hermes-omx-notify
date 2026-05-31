#!/usr/bin/env bash
set -euo pipefail

script_path="$(readlink -f -- "${BASH_SOURCE[0]}")"
script_dir="$(cd -- "$(dirname -- "$script_path")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

usage() {
  cat <<USAGE
Usage:
  bin/install.sh [install-omx-cli options]

Description:
  Install only the core hermes-omx-notify helper CLIs onto PATH:
    omx-new
    omx-send
    omx-kill

This core installer is a thin wrapper around scripts/install-omx-cli.sh.
It does not install AgentMemory, CodeGraph, Codex hooks, omx-bootstrap, omx-status,
omx-sync, or other agent-extension tooling.

Common options:
  --dir PATH      Target bin directory (default: ~/.local/bin)
  --force         Replace existing files or symlinks
  --copy          Install copies instead of symlinks
  --uninstall     Remove helper links/copies installed from this repository
  --dry-run       Print actions without changing files
  -h, --help      Show this help
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --hooks|--no-global)
      printf 'error: %s belonged to the old extension installer and is not supported by bridge core\n' "$arg" >&2
      printf 'hint: use scripts/install-omx-cli.sh or bin/install.sh for omx-new/omx-send/omx-kill only\n' >&2
      exit 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
  esac
done

exec "$repo_root/scripts/install-omx-cli.sh" --repo-root "$repo_root" "$@"
