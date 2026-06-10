#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install canonical gajae-version tmux helper CLIs onto PATH.

Usage:
  scripts/install-omx-cli.sh [options]

Installs:
  tm-new   Start a managed GJC tmux session
  tm-send  Send follow-up commands through the bridge API or managed tmux targets
  tm-kill  Stop a managed GJC tmux session

Options:
  --dir PATH          Target bin directory (default: $OMX_CLI_INSTALL_DIR or ~/.local/bin)
  --repo-root PATH    Bridge repository root (default: parent of scripts/)
  --copy              Copy files instead of creating symlinks
  --force             Replace existing files/links at the target path
  --uninstall         Remove symlinks/copies installed from this repository
  --dry-run           Print actions without writing
  -h, --help          Show help

Notes:
  - This installer manages only canonical tm-new, tm-send, and tm-kill.
  - Stale omx-* and tmux-* helper symlinks from older installs are removed when repository-managed.
  - It does not install or modify Codex global hooks.
  - Keep the target directory on PATH for Hermes/Gateway workers.
USAGE
}

script_name="$(basename "$0")"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
target_dir="${OMX_CLI_INSTALL_DIR:-$HOME/.local/bin}"
copy_mode=0
force=0
uninstall=0
dry_run=0
tools=(tm-new tm-send tm-kill)
legacy_tools=(omx-new omx-send omx-kill tmux-new tmux-send tmux-kill)

log() { printf '%s\n' "$*"; }
die() { echo "$script_name: $*" >&2; exit 1; }

trim_trailing_slash() {
  local value="$1"
  while [[ "$value" != "/" && "$value" == */ ]]; do value="${value%/}"; done
  printf '%s' "$value"
}

path_contains_dir() {
  local dir="$1"
  case ":$PATH:" in *":$dir:"*) return 0 ;; *) return 1 ;; esac
}

source_tool_for() {
  case "$1" in
    tm-new) printf 'tm-new' ;;
    tm-send) printf 'tm-send' ;;
    tm-kill) printf 'tm-kill' ;;
    *) return 1 ;;
  esac
}

legacy_hash_for() {
  case "$1" in
    omx-new) printf '26cf5acba826c6831721a674c92d260cd1dc3b5a936d42978f80bc869e6b2b0f' ;;
    omx-send) printf '0d988aa05f0a2214990b0af8ba270895c03b7c68b2720d75ce4af510c06dd0ee' ;;
    omx-kill) printf '5618748fac135610dce2185f449d67a0260a895b120bb2e9fdd5dda570d1f2e9' ;;
    tmux-new) printf '3a635c6a9d9433778d19ff7417b5dd3115de4854b6efc8eaf01eeaaacadb267e' ;;
    tmux-send) printf '790bcddae17086ba74d07203bcc0c61add5647e8773bb21fb6b734d4532ed0eb' ;;
    tmux-kill) printf 'c27a724af232a5f4a85eb5a1041d63fd010c244575143e3585c2c26708660df7' ;;
    *) return 1 ;;
  esac
}

remove_legacy_tool() {
  local tool="$1" src dst current_target="" expected_hash="" actual_hash=""
  src="$repo_root/bin/$tool"
  dst="$target_dir/$tool"

  if [[ "$dry_run" == "1" ]]; then
    log "DRY-RUN: remove repository-managed legacy helper '$dst' if present"
    return 0
  fi

  [[ -e "$dst" || -L "$dst" ]] || return 0

  if [[ -L "$dst" ]]; then
    current_target="$(readlink "$dst" || true)"
    if [[ "$current_target" == "$src" ]]; then
      rm -f "$dst"
      log "Removed legacy symlink: $dst"
      return 0
    fi
    log "Skipping non-managed legacy symlink: $dst -> $current_target"
    return 0
  fi

  expected_hash="$(legacy_hash_for "$tool" || true)"
  if [[ -n "$expected_hash" ]] && command -v sha256sum >/dev/null 2>&1; then
    actual_hash="$(sha256sum "$dst" | awk '{print $1}')"
    if [[ "$actual_hash" == "$expected_hash" ]]; then
      rm -f "$dst"
      log "Removed legacy copied helper: $dst"
      return 0
    fi
  elif [[ -f "$src" ]] && cmp -s "$src" "$dst"; then
    rm -f "$dst"
    log "Removed legacy copied helper: $dst"
    return 0
  fi

  log "Skipping non-managed legacy target: $dst"
}

install_tool() {
  local tool="$1" source_tool src dst current_target=""
  source_tool="$(source_tool_for "$tool")" || die "unknown tool mapping: $tool"
  src="$repo_root/bin/$source_tool"
  dst="$target_dir/$tool"
  [[ -x "$src" ]] || die "missing executable source: $src"

  if [[ "$dry_run" == "1" ]]; then
    if [[ "$copy_mode" == "1" ]]; then
      log "DRY-RUN: install -m 0755 '$src' '$dst'"
    else
      log "DRY-RUN: ln -s '$src' '$dst'"
    fi
    return 0
  fi

  mkdir -p "$target_dir"
  if [[ -L "$dst" ]]; then
    current_target="$(readlink "$dst" || true)"
    if [[ "$current_target" == "$src" && "$copy_mode" == "0" ]]; then
      log "Already installed: $dst -> $src"
      return 0
    fi
  fi

  if [[ -e "$dst" || -L "$dst" ]]; then
    if [[ "$force" == "1" ]]; then
      rm -f "$dst"
    else
      die "target exists: $dst (use --force to replace it)"
    fi
  fi

  if [[ "$copy_mode" == "1" ]]; then
    install -m 0755 "$src" "$dst"
    log "Installed copy: $dst"
  else
    ln -s "$src" "$dst"
    log "Installed symlink: $dst -> $src"
  fi
}

uninstall_tool() {
  local tool="$1" source_tool src dst current_target=""
  source_tool="$(source_tool_for "$tool")" || die "unknown tool mapping: $tool"
  src="$repo_root/bin/$source_tool"
  dst="$target_dir/$tool"
  if [[ "$dry_run" == "1" ]]; then
    log "DRY-RUN: remove repository-managed '$dst' if present"
    return 0
  fi

  if [[ ! -e "$dst" && ! -L "$dst" ]]; then
    log "Already absent: $dst"
    return 0
  fi

  if [[ -L "$dst" ]]; then
    current_target="$(readlink "$dst" || true)"
    if [[ "$current_target" == "$src" ]]; then
      rm -f "$dst"
      log "Removed symlink: $dst"
      return 0
    fi
    die "refusing to remove symlink not managed by this repository: $dst -> $current_target"
  fi

  if cmp -s "$src" "$dst"; then
    rm -f "$dst"
    log "Removed copied helper: $dst"
    return 0
  fi

  die "refusing to remove file not matching repository helper: $dst"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) target_dir="${2:?missing --dir value}"; shift 2 ;;
    --repo-root) repo_root="${2:?missing --repo-root value}"; shift 2 ;;
    --copy) copy_mode=1; shift ;;
    --force) force=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

repo_root="$(cd "$repo_root" && pwd)"
target_dir="$(trim_trailing_slash "$target_dir")"

if [[ "$dry_run" != "1" ]]; then
  mkdir -p "$target_dir"
fi

for legacy_tool in "${legacy_tools[@]}"; do
  remove_legacy_tool "$legacy_tool"
done

for tool in "${tools[@]}"; do
  if [[ "$uninstall" == "1" ]]; then
    uninstall_tool "$tool"
  else
    install_tool "$tool"
  fi
done

log ""
log "Target dir: $target_dir"
if path_contains_dir "$target_dir"; then
  log "PATH check: ok"
else
  log "PATH check: $target_dir is not currently on PATH"
  log "  export PATH=\"$target_dir:\$PATH\""
fi
