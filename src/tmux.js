import { execFileSync, spawnSync } from 'node:child_process';

const PANE_RE = /^%\d+$/;
const DEFAULT_ENTER_RETRY_COUNT = 4;
const DEFAULT_ENTER_DELAY_MS = 250;

function runTmux(args) {
  return execFileSync(process.env.TMUX_BIN || 'tmux', args, {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function listTmuxPanes() {
  try {
    const output = runTmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_path}']);
    if (!output) return [];
    return output.split('\n').filter(Boolean).map((line) => {
      const [sessionName, paneId, panePid, paneDead, paneCurrentPath] = line.split('\t');
      return {
        tmuxId: sessionName,
        tmuxPaneId: paneId,
        panePid: Number.parseInt(panePid, 10),
        paneDead: paneDead === '1',
        paneCurrentPath,
      };
    });
  } catch {
    return [];
  }
}

export function listTmuxSessions() {
  try {
    const output = runTmux(['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}']);
    if (!output) return [];
    return output.split('\n').filter(Boolean).map((line) => {
      const [tmuxId, createdRaw, attachedRaw] = line.split('\t');
      return {
        tmuxId,
        createdAt: Number.isFinite(Number(createdRaw)) ? new Date(Number(createdRaw) * 1000).toISOString() : null,
        attached: attachedRaw === '1',
      };
    });
  } catch {
    return [];
  }
}

export function sendToTmux(target, text, { submit = true } = {}) {
  if (!target || typeof target !== 'string') {
    return { ok: false, error: 'missing tmux target' };
  }
  const safeText = String(text || '').replace(/\r?\n/g, ' ');
  const calls = [['send-keys', '-t', target, '-l', '--', safeText]];
  if (submit) {
    const retryCount = Number.parseInt(process.env.TMUX_SUBMIT_RETRY_COUNT || `${DEFAULT_ENTER_RETRY_COUNT}`, 10);
    const delayMs = Number.parseInt(process.env.TMUX_SUBMIT_DELAY_MS || `${DEFAULT_ENTER_DELAY_MS}`, 10);
    for (let index = 0; index < Math.max(1, retryCount); index += 1) {
      calls.push({ delayMs: Math.max(0, delayMs) });
      calls.push(['send-keys', '-t', target, 'Enter']);
    }
  }
  for (const args of calls) {
    if (!Array.isArray(args)) {
      if (args.delayMs > 0) sleepSync(args.delayMs);
      continue;
    }
    const result = spawnSync(process.env.TMUX_BIN || 'tmux', args, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
      return { ok: false, error: result.error?.message || result.stderr || `tmux exited ${result.status}` };
    }
  }
  return { ok: true };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function targetForSession(session) {
  if (session?.tmuxPaneId && PANE_RE.test(session.tmuxPaneId)) return session.tmuxPaneId;
  return session?.tmuxId || null;
}
