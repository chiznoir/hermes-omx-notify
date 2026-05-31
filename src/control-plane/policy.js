const VALID_MODES = new Set(['auto', 'codex', 'tmux']);

export function normalizeCommandMode(mode) {
  return VALID_MODES.has(mode) ? mode : 'auto';
}

export function decideBackend(session = {}, command = {}) {
  const mode = normalizeCommandMode(command.mode);

  if (mode === 'codex') {
    return { backend: null, reason: 'mode-codex-unsupported', unsupported: true };
  }
  if (mode === 'tmux') {
    return { backend: 'tmux', reason: 'mode-tmux-forced' };
  }
  if (command.visible === true) {
    return { backend: 'tmux', reason: 'visible-control-requested' };
  }

  return { backend: 'tmux', reason: 'auto-tmux-default' };
}
