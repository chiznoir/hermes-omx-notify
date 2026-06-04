import {
  buildSessionIndex as buildGjcSessionIndex,
  getSessionById as getRawGjcSessionById,
  resolveSessionId as resolveGjcSessionId,
} from '../gjc.js';
import {
  buildSessionIndex as buildOmxSessionIndex,
  getSessionById as getRawOmxSessionById,
  resolveSessionId as resolveOmxSessionId,
} from '../omx.js';

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
  const bridgeSessionId = session.bridgeSessionId
    || session.gjcSessionId
    || session.codexSessionId
    || session.omxSessionId
    || session.threadId
    || session.tmuxPaneId
    || session.tmuxId;
  const sources = [];
  if (session.sessionLogPath) sources.push({ source: session.backend === 'gjc' ? 'gjc-log' : 'codex-log', path: session.sessionLogPath });
  if (session.omxSessionId) sources.push({ source: 'omx-log' });
  if (session.tmuxId || session.tmuxPaneId) sources.push(compactObject({ source: 'tmux', tmuxId: session.tmuxId, tmuxPaneId: session.tmuxPaneId }));

  return {
    ...session,
    bridgeSessionId,
    gjcSessionId: session.gjcSessionId || (session.backend === 'gjc' ? bridgeSessionId : null),
    codexThreadId: session.codexThreadId || session.threadId || session.gjcSessionId || session.codexSessionId || null,
    kind: session.kind || inferSessionKind(session),
    sources: session.sources || sources,
  };
}

export function isCodexOnlySession(session = {}) {
  if (session.backend === 'gjc') return false;
  return session.hasOmxLifecycle === false;
}

function includeCodexOnlySessions(options = {}) {
  return options.includeCodexOnlySessions === true
    || options.includeNativeOnlySessions === true
    || options.includeCodexOnly === true
    || options.includeNativeOnly === true;
}

function dedupeSessions(sessions = []) {
  const byId = new Map();
  for (const session of sessions) {
    const enriched = enrichSession(session);
    const key = enriched.bridgeSessionId || enriched.codexThreadId;
    if (!key) continue;
    if (!byId.has(key)) byId.set(key, enriched);
  }
  return [...byId.values()];
}

async function buildCombinedSessionIndex(options = {}) {
  const [gjcSessions, omxSessions] = await Promise.all([
    buildGjcSessionIndex(options),
    buildOmxSessionIndex(options),
  ]);
  return dedupeSessions([...gjcSessions, ...omxSessions]);
}

export async function listSessions(options = {}) {
  const sessions = await buildCombinedSessionIndex(options);
  if (includeCodexOnlySessions(options)) return sessions;
  return sessions.filter((session) => !isCodexOnlySession(session));
}

export async function getSessionById(id, options = {}) {
  const [gjc, omx] = await Promise.all([
    getRawGjcSessionById(id, options),
    getRawOmxSessionById(id, options),
  ]);
  if (gjc) return enrichSession(gjc);
  if (omx) return enrichSession(omx);

  const sessions = await listSessions(options);
  return sessions.find((session) => {
    if ([session.bridgeSessionId, session.codexThreadId, session.gjcSessionId].filter(Boolean).includes(id)) return true;
    return resolveGjcSessionId(session, id) || resolveOmxSessionId(session, id);
  }) || null;
}
