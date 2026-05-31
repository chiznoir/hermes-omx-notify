import { buildSessionIndex, getSessionById as getRawSessionById, resolveSessionId } from '../omx.js';

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

export function inferSessionKind(session = {}) {
  const tmuxId = String(session.tmuxId || '');
  const cwd = String(session.cwd || '');
  const project = String(session.project || '');
  const haystack = `${tmuxId} ${cwd} ${project}`.toLowerCase();
  if (/omx[-_]?team|swarm|worker-\d+/.test(haystack) || cwd.includes('/.omx/team/')) return 'omx-team';
  if (session.tmuxId || session.tmuxPaneId) return 'omx-tmux';
  if (/\.omx\/plugins|omx-plugin/.test(haystack)) return 'omx-plugin';
  return 'codex-thread';
}

export function enrichSession(session) {
  const bridgeSessionId = session.codexSessionId || session.omxSessionId || session.threadId || session.tmuxPaneId || session.tmuxId;
  const sources = [];
  if (session.sessionLogPath) sources.push({ source: 'codex-log', path: session.sessionLogPath });
  if (session.omxSessionId) sources.push({ source: 'omx-log' });
  if (session.tmuxId || session.tmuxPaneId) sources.push(compactObject({ source: 'tmux', tmuxId: session.tmuxId, tmuxPaneId: session.tmuxPaneId }));

  return {
    ...session,
    bridgeSessionId,
    codexThreadId: session.threadId || session.codexSessionId || null,
    kind: session.kind || inferSessionKind(session),
    sources,
  };
}

export function isCodexOnlySession(session = {}) {
  return session.hasOmxLifecycle === false;
}

function includeCodexOnlySessions(options = {}) {
  return options.includeCodexOnlySessions === true
    || options.includeNativeOnlySessions === true
    || options.includeCodexOnly === true
    || options.includeNativeOnly === true;
}

export async function listSessions(options = {}) {
  const sessions = (await buildSessionIndex(options)).map(enrichSession);
  if (includeCodexOnlySessions(options)) return sessions;
  return sessions.filter((session) => !isCodexOnlySession(session));
}

export async function getSessionById(id, options = {}) {
  const raw = await getRawSessionById(id, options);
  if (raw) return enrichSession(raw);

  const sessions = await listSessions(options);
  return sessions.find((session) => {
    if ([session.bridgeSessionId, session.codexThreadId].filter(Boolean).includes(id)) return true;
    return resolveSessionId(session, id);
  }) || null;
}
