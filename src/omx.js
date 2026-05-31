import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, delimiter, resolve } from 'node:path';
import { readJsonl, listFilesRecursive, ensureDirFor } from './jsonl.js';
import { isAuxiliaryCodexLog, listCodexSessionLogPaths, readCodexLog } from './codex-log.js';
import { listTmuxPanes, listTmuxSessions } from './tmux.js';
import { bridgeStatePath } from './bridge-paths.js';
import { eventIndexPath } from './control-plane/event-index.js';
import {
  asString,
  canonicalProjectRoot,
  canonicalStatus,
  clearEndedAtForResumedCodexLog,
  codexLogAttachmentMetadata,
  codexLogBeforeNextLifecycle,
  codexLogHasUserMessageAfter,
  codexLogOwnerMatchSource,
  dedupeSessions,
  firstSetValue,
  inheritedOwnedSessionIdForCurrentState,
  isNativeOnlyStartRecord,
  isOwnedLifecycleEntry,
  isOwnedReconcileRecord,
  latestCodexLogActivityAt,
  latestCodexUserMessageAt,
  latestIso,
  mapSet,
  mergeAssociatedCodexLogs,
  mergeSessionEntry,
  nextLifecycleStartsByEntryKey,
  preferredEntryForCodexLog,
  preReadSessionSortKey,
  projectCwdForSession,
  projectNameFromCwd,
  replacedNativeSessionIds,
  sessionIndexKey,
  sortableMs,
  teamWorkerSourceCwd,
} from './omx-session-utils.js';

const DEFAULT_DISCOVERED_PROJECT_ROOT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DISCOVERED_PROJECT_ROOT_REFRESH_MS = 60 * 1000;
const DEFAULT_DISCOVERED_PROJECT_ROOT_MAX = 8;
const DEFAULT_MADMAX_RUN_REGISTRY_TAIL_BYTES = 1024 * 1024;
const DEFAULT_MADMAX_RUN_MAX = 8;
const DEFAULT_MADMAX_RUN_LOOKBACK_MS = 12 * 60 * 60 * 1000;
const DEFAULT_TERMINAL_PENDING_ROOT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TERMINAL_PENDING_ROOT_MAX = 64;
const DEFAULT_TMUX_ATTACH_MAX_SKEW_MS = 10 * 60 * 1000;
const DEFAULT_CODEX_CWD_ATTACH_SCAN_LIMIT = 30;
const DEFAULT_CODEX_CWD_ATTACH_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_OBSERVED_SESSION_END_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_OBSERVED_SESSION_END_LOOKBACK_MS = 6 * 60 * 60 * 1000;

function numericOption(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function readCodexLogForBuild(file, options = {}) {
  if (typeof options.readCodexLogFn === 'function') return options.readCodexLogFn(file);
  return readCodexLog(file);
}

function numericOptionWithDefault(value, defaultValue) {
  return numericOption(value) || defaultValue;
}

function tmuxAttachMaxSkewMs(options = {}) {
  return numericOptionWithDefault(
    process.env.BRIDGE_TMUX_ATTACH_MAX_SKEW_MS || options.tmuxAttachMaxSkewMs,
    DEFAULT_TMUX_ATTACH_MAX_SKEW_MS,
  );
}

function codexCwdAttachScanLimit(options = {}) {
  return numericOptionWithDefault(
    process.env.BRIDGE_CODEX_CWD_ATTACH_SCAN_LIMIT || options.codexCwdAttachScanLimit,
    DEFAULT_CODEX_CWD_ATTACH_SCAN_LIMIT,
  );
}

function codexCwdAttachWindowMs(options = {}) {
  return numericOptionWithDefault(
    process.env.BRIDGE_CODEX_CWD_ATTACH_WINDOW_MS || options.codexCwdAttachWindowMs,
    DEFAULT_CODEX_CWD_ATTACH_WINDOW_MS,
  );
}

function observedSessionEndEnabled(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'observedSessionEndEnabled')) {
    return options.observedSessionEndEnabled !== false;
  }
  return !falseyEnv(process.env.BRIDGE_OBSERVED_SESSION_END_ENABLED);
}

function observedSessionEndGraceMs(options = {}) {
  return numericOptionWithDefault(
    process.env.BRIDGE_OBSERVED_SESSION_END_GRACE_MS || options.observedSessionEndGraceMs,
    DEFAULT_OBSERVED_SESSION_END_GRACE_MS,
  );
}

function observedSessionEndLookbackMs(options = {}) {
  return numericOptionWithDefault(
    process.env.BRIDGE_OBSERVED_SESSION_END_LOOKBACK_MS || options.observedSessionEndLookbackMs,
    DEFAULT_OBSERVED_SESSION_END_LOOKBACK_MS,
  );
}

function truthyEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function falseyEnv(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').toLowerCase());
}

function isoNow(options = {}) {
  const value = options.now || new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

async function attachRecentCodexLogsById(byCodex, codexFiles = [], options = {}) {
  const limit = Math.min(codexFiles.length, codexCwdAttachScanLimit(options));
  for (const file of codexFiles.slice(0, limit)) {
    const log = await readCodexLogForBuild(file, options);
    if (!log.codexSessionId || isAuxiliaryCodexLog(log)) continue;
    const match = preferredEntryForCodexLog(byCodex, log);
    if (!match) continue;
    const { key, entry } = match;
    byCodex.set(key, mergeSessionEntry(entry, {
      sessionLogPath: entry.sessionLogPath || file,
      log,
      cwd: entry.cwd || log.cwd,
      lastCodexLogActivityAt: latestCodexLogActivityAt(log),
      lastCodexUserMessageAt: latestCodexUserMessageAt(log),
      ...codexLogAttachmentMetadata(entry, log, entry.sessionLogMatchSource || 'id-fragment'),
    }));
  }
}

function removeOwnedCodexShadowSessions(scanByCodex) {
  const activeOwnedCodexIds = new Set([...scanByCodex.entries()]
    .filter(([, entry]) => (
      entry.hasOmxLifecycle === true
      && entry.isCurrentState === true
      && !entry.endedAt
      && entry.omxSessionId
      && entry.codexSessionId
      && entry.omxSessionId !== entry.codexSessionId
    ))
    .map(([, entry]) => entry.codexSessionId));
  for (const [key, entry] of [...scanByCodex.entries()]) {
    if (!activeOwnedCodexIds.has(entry.codexSessionId || key)) continue;
    if (entry.hasOmxLifecycle === true && entry.isCurrentState === true && !entry.endedAt) continue;
    if (entry.hasOmxLifecycle === true) {
      const restoredCodexSessionId = entry.omxSessionId || key;
      scanByCodex.set(key, {
        ...entry,
        codexSessionId: restoredCodexSessionId,
        threadId: restoredCodexSessionId,
        sessionLogPath: null,
        log: null,
        associatedCodexLogs: [],
        sessionLogMatchSource: null,
        sessionLogOwnerMatch: null,
        runtimeOmxSessionId: null,
        runtimeTmuxId: null,
      });
      continue;
    }
    scanByCodex.delete(key);
  }

  const ownedCodexIds = new Set([...scanByCodex.entries()]
    .filter(([key, entry]) => (
      entry.hasOmxLifecycle === true
      && entry.omxSessionId
      && entry.codexSessionId
      && key !== entry.codexSessionId
    ))
    .map(([, entry]) => entry.codexSessionId));
  if (ownedCodexIds.size === 0) return;
  for (const [key, entry] of [...scanByCodex.entries()]) {
    if (entry.hasOmxLifecycle === true) continue;
    if (ownedCodexIds.has(entry.codexSessionId || key)) scanByCodex.delete(key);
  }
}

function limitPreReadSessions(byCodex, hookMappings, options = {}) {
  const limit = numericOption(options.sessionScanLimit);
  if (!limit || byCodex.size <= limit) return byCodex;

  return new Map([...byCodex.entries()]
    .sort(([leftId, left], [rightId, right]) => {
      const leftLifecycleRank = left.hasOmxLifecycle === true ? 0 : 1;
      const rightLifecycleRank = right.hasOmxLifecycle === true ? 0 : 1;
      if (leftLifecycleRank !== rightLifecycleRank) return leftLifecycleRank - rightLifecycleRank;
      const timeDelta = sortableMs(preReadSessionSortKey(right, hookMappings.get(rightId)))
        - sortableMs(preReadSessionSortKey(left, hookMappings.get(leftId)));
      if (timeDelta !== 0) return timeDelta;
      const leftActiveRank = left.endedAt ? 1 : 0;
      const rightActiveRank = right.endedAt ? 1 : 0;
      return leftActiveRank - rightActiveRank;
    })
    .slice(0, limit));
}

export function projectOmxLogsDir(projectRoot = process.cwd()) {
  return join(projectRoot, '.omx', 'logs');
}

function discoveredProjectRootsPath(projectRoot = process.cwd(), options = {}) {
  return options.discoveredProjectRootsPath
    || process.env.BRIDGE_DISCOVERED_PROJECT_ROOTS_PATH
    || (process.env.BRIDGE_STATE_ROOT || options.bridgeStateRoot
      ? bridgeStatePath('bridge-discovered-project-roots.json', options)
      : null)
    || join(projectRoot, '.omx', 'state', 'bridge-discovered-project-roots.json');
}

function rememberDiscoveredProjectRoots(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'rememberDiscoveredProjectRoots')) {
    return options.rememberDiscoveredProjectRoots !== false;
  }
  return !falseyEnv(process.env.BRIDGE_REMEMBER_DISCOVERED_PROJECT_ROOTS);
}

function discoveredProjectRootRetentionMs(options = {}) {
  const explicitMs = numericOption(process.env.BRIDGE_DISCOVERED_PROJECT_ROOT_RETENTION_MS || options.discoveredProjectRootRetentionMs);
  if (explicitMs) return explicitMs;
  const days = numericOption(process.env.BRIDGE_DISCOVERED_PROJECT_ROOT_RETENTION_DAYS || options.discoveredProjectRootRetentionDays);
  if (days) return days * 24 * 60 * 60 * 1000;
  return DEFAULT_DISCOVERED_PROJECT_ROOT_RETENTION_MS;
}

function discoveredProjectRootMax(options = {}) {
  return numericOption(process.env.BRIDGE_DISCOVERED_PROJECT_ROOT_MAX || options.discoveredProjectRootMax)
    || DEFAULT_DISCOVERED_PROJECT_ROOT_MAX;
}

function discoveredProjectRootRefreshMs(options = {}) {
  return numericOption(process.env.BRIDGE_DISCOVERED_PROJECT_ROOT_REFRESH_MS || options.discoveredProjectRootRefreshMs)
    || DEFAULT_DISCOVERED_PROJECT_ROOT_REFRESH_MS;
}

function hasOmxLogs(root) {
  return root && existsSync(projectOmxLogsDir(root));
}

function madmaxRunMetadataPath(root) {
  return join(root, '.omxbox-run.json');
}

async function readMadmaxRunMetadata(root) {
  if (!root || !existsSync(madmaxRunMetadataPath(root))) return null;
  try {
    const parsed = JSON.parse(await readFile(madmaxRunMetadataPath(root), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      root: canonicalProjectRoot(parsed.cwd || root),
      sourceCwd: asString(parsed.source_cwd),
      createdAt: asString(parsed.created_at),
      launcher: asString(parsed.launcher),
    };
  } catch (error) {
    console.error(`[omx-bridge] failed to read madmax run metadata ${madmaxRunMetadataPath(root)}: ${error?.message || error}`);
    return null;
  }
}

function omxRunsDir(options = {}) {
  return expandMaybeRelativePath(
    options.omxRunsDir
    || process.env.BRIDGE_OMX_RUNS_DIR
    || process.env.OMX_RUNS_DIR
    || join(homedir(), '.omx-runs'),
    process.cwd(),
  );
}

function madmaxRunMax(options = {}) {
  return numericOptionWithDefault(process.env.BRIDGE_MADMAX_RUN_MAX || options.madmaxRunMax, DEFAULT_MADMAX_RUN_MAX);
}

function madmaxRunLookbackMs(options = {}) {
  const explicitMs = numericOption(process.env.BRIDGE_MADMAX_RUN_LOOKBACK_MS || options.madmaxRunLookbackMs);
  if (explicitMs) return explicitMs;
  const hours = numericOption(process.env.BRIDGE_MADMAX_RUN_LOOKBACK_HOURS || options.madmaxRunLookbackHours);
  if (hours) return hours * 60 * 60 * 1000;
  return DEFAULT_MADMAX_RUN_LOOKBACK_MS;
}

function madmaxRunRegistryTailBytes(options = {}) {
  return numericOptionWithDefault(
    process.env.BRIDGE_MADMAX_RUN_REGISTRY_TAIL_BYTES || options.madmaxRunRegistryTailBytes,
    DEFAULT_MADMAX_RUN_REGISTRY_TAIL_BYTES,
  );
}

function terminalPendingRootDiscoveryEnabled(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'terminalPendingRootDiscoveryEnabled')) {
    return options.terminalPendingRootDiscoveryEnabled !== false;
  }
  return !falseyEnv(process.env.BRIDGE_TERMINAL_PENDING_ROOT_DISCOVERY_ENABLED);
}

function terminalPendingRootRetentionMs(options = {}) {
  const explicitMs = numericOption(process.env.BRIDGE_TERMINAL_PENDING_ROOT_RETENTION_MS || options.terminalPendingRootRetentionMs);
  if (explicitMs) return explicitMs;
  const hours = numericOption(process.env.BRIDGE_TERMINAL_PENDING_ROOT_RETENTION_HOURS || options.terminalPendingRootRetentionHours);
  if (hours) return hours * 60 * 60 * 1000;
  return DEFAULT_TERMINAL_PENDING_ROOT_RETENTION_MS;
}

function terminalPendingRootMax(options = {}) {
  return numericOptionWithDefault(
    process.env.BRIDGE_TERMINAL_PENDING_ROOT_MAX || options.terminalPendingRootMax,
    DEFAULT_TERMINAL_PENDING_ROOT_MAX,
  );
}

function eventIndexHasTerminalPendingRoots(path) {
  if (!path || !existsSync(path)) return false;
  return true;
}

function terminalPendingRootFreshEnough(lastSeenAt, options = {}) {
  const nowMs = Date.parse(isoNow(options));
  const lastSeenMs = Date.parse(lastSeenAt || '');
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastSeenMs)) return true;
  return nowMs - lastSeenMs <= terminalPendingRootRetentionMs(options);
}

async function readTerminalPendingProjectRootRecords(projectRoot, options = {}) {
  if (!terminalPendingRootDiscoveryEnabled(options)) return [];
  const path = eventIndexPath(projectRoot, options);
  if (!eventIndexHasTerminalPendingRoots(path)) return [];

  let db = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(`
      SELECT
        json_extract(start.session_json, '$.omxProjectRoot') AS root,
        MAX(start.updated_at) AS lastSeenAt
      FROM events start
      WHERE start.event_type = 'SessionStart'
        AND start.source = 'notification'
        AND json_extract(start.session_json, '$.omxProjectRoot') IS NOT NULL
        AND json_extract(start.session_json, '$.hasOmxLifecycle') = 1
        AND json_extract(start.session_json, '$.omxSessionId') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM events terminal
          WHERE terminal.event_type = 'SessionEnd'
            AND (
              terminal.event_id = json_extract(start.session_json, '$.omxSessionId') || ':end'
              OR json_extract(terminal.session_json, '$.omxSessionId') = json_extract(start.session_json, '$.omxSessionId')
            )
          LIMIT 1
        )
      GROUP BY root
      ORDER BY lastSeenAt DESC
      LIMIT ?
    `).all(terminalPendingRootMax(options));
    return rows
      .map((row) => ({
        root: canonicalProjectRoot(row.root),
        lastSeenAt: row.lastSeenAt || isoNow(options),
        source: 'event-index-terminal-pending',
      }))
      .filter((record) => record.root && hasOmxLogs(record.root))
      .filter((record) => terminalPendingRootFreshEnough(record.lastSeenAt, options));
  } catch (error) {
    if (options.warnOnTerminalPendingRootDiscoveryError !== false) {
      console.error(`[omx-bridge] failed to read terminal pending roots from event index ${path}: ${error?.message || error}`);
    }
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures after a best-effort discovery hint read.
    }
  }
}

function expandMaybeRelativePath(value, cwd) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw.startsWith('/') ? raw : resolve(cwd, raw);
}

function discoverMadmaxRuns(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'discoverMadmaxRuns')) {
    return options.discoverMadmaxRuns !== false;
  }
  return !falseyEnv(process.env.BRIDGE_DISCOVER_MADMAX_RUNS);
}

function includeAllMadmaxRuns(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'includeAllMadmaxRuns')) {
    return options.includeAllMadmaxRuns === true;
  }
  return truthyEnv(process.env.BRIDGE_INCLUDE_ALL_MADMAX_RUNS);
}

function scanMadmaxRunDirectories(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'scanMadmaxRunDirectories')) {
    return options.scanMadmaxRunDirectories === true;
  }
  return truthyEnv(process.env.BRIDGE_SCAN_MADMAX_RUN_DIRS);
}

function normalizeMadmaxRegistryRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const root = asString(record.cwd) || asString(record.root);
  if (!root) return null;
  return {
    root,
    sourceCwd: asString(record.source_cwd) || asString(record.sourceCwd),
    createdAt: asString(record.created_at) || asString(record.createdAt),
    launcher: asString(record.launcher),
  };
}

async function listMadmaxRunDirectoryRecords(runsDir) {
  if (!runsDir || !existsSync(runsDir)) return [];
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const metadata = await readMadmaxRunMetadata(join(runsDir, entry.name));
    if (metadata) records.push(metadata);
  }
  return records;
}

async function readRecentJsonlRecords(filePath, options = {}) {
  if (!filePath || !existsSync(filePath)) return [];
  const bytes = madmaxRunRegistryTailBytes(options);
  const stats = await stat(filePath).catch(() => null);
  if (!stats?.size) return [];
  const start = Math.max(0, stats.size - bytes);
  const length = stats.size - start;
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf8');
    const safeText = start === 0 ? text : text.slice(text.indexOf('\n') + 1);
    return safeText
      .split('\n')
      .map((line) => {
        if (!line.trim()) return null;
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } finally {
    await handle.close();
  }
}

function pruneMadmaxRunRecords(records = [], options = {}) {
  const maxRuns = madmaxRunMax(options);
  const nowMs = Date.parse(isoNow(options));
  const lookbackMs = madmaxRunLookbackMs(options);
  const recordsByRoot = new Map();
  for (const record of records) {
    const root = canonicalProjectRoot(record.root);
    if (!root || !hasOmxLogs(root)) continue;
    const createdMs = Date.parse(record.createdAt || '');
    if (
      Number.isFinite(nowMs)
      && Number.isFinite(createdMs)
      && lookbackMs > 0
      && nowMs - createdMs > lookbackMs
    ) continue;
    const previous = recordsByRoot.get(root) || {};
    recordsByRoot.set(root, {
      ...previous,
      ...record,
      root,
      sourceCwd: record.sourceCwd || previous.sourceCwd,
      createdAt: record.createdAt || previous.createdAt,
      source: 'madmax-isolated',
    });
  }
  return [...recordsByRoot.values()]
    .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''))
    .slice(0, maxRuns);
}

function filterMadmaxRunRootRecords(records, sourceRoots = [], options = {}) {
  if (includeAllMadmaxRuns(options)) return records;
  const sourceRootSet = new Set(uniqueProjectRoots(sourceRoots));
  const runRootSet = new Set(uniqueProjectRoots(sourceRoots).filter((root) => existsSync(madmaxRunMetadataPath(root))));
  return records.filter((record) => {
    const root = canonicalProjectRoot(record.root);
    const sourceCwd = record.sourceCwd ? canonicalProjectRoot(record.sourceCwd) : null;
    return runRootSet.has(root) || (sourceCwd && sourceRootSet.has(sourceCwd));
  });
}

async function readMadmaxRunRootRecords(sourceRoots = [], options = {}) {
  if (!discoverMadmaxRuns(options)) return [];
  const runsDir = omxRunsDir(options);
  if (!runsDir || !existsSync(runsDir)) return [];

  const registryRecords = (await readRecentJsonlRecords(join(runsDir, 'registry.jsonl'), options))
    .map(normalizeMadmaxRegistryRecord)
    .filter(Boolean);
  const filteredRegistryRecords = filterMadmaxRunRootRecords(registryRecords, sourceRoots, options);
  const directoryRecords = scanMadmaxRunDirectories(options)
    ? filterMadmaxRunRootRecords(await listMadmaxRunDirectoryRecords(runsDir), sourceRoots, options)
    : [];
  return pruneMadmaxRunRecords([...filteredRegistryRecords, ...directoryRecords], options);
}

async function sourceCwdForOmxRoot(projectRoot) {
  const metadata = await readMadmaxRunMetadata(projectRoot);
  return metadata?.sourceCwd || teamWorkerSourceCwd(projectRoot) || null;
}

function normalizeDiscoveredProjectRootRecords(parsed) {
  const rawRecords = Array.isArray(parsed) ? parsed : parsed?.roots;
  if (!Array.isArray(rawRecords)) return [];
  return rawRecords
    .map((record) => {
      if (typeof record === 'string') return { root: record, lastSeenAt: null };
      if (!record || typeof record !== 'object') return null;
      return {
        root: asString(record.root),
        lastSeenAt: asString(record.lastSeenAt) || asString(record.last_seen_at),
        source: asString(record.source),
      };
    })
    .filter((record) => record?.root);
}

async function readDiscoveredProjectRootRecords(projectRoot, options = {}) {
  if (!rememberDiscoveredProjectRoots(options)) return [];
  const path = discoveredProjectRootsPath(projectRoot, options);
  if (!existsSync(path)) return [];
  try {
    return pruneDiscoveredProjectRootRecords(
      normalizeDiscoveredProjectRootRecords(JSON.parse(await readFile(path, 'utf8'))),
      options,
    );
  } catch (error) {
    if (options.warnOnDiscoveredProjectRootRegistryError !== false) {
      console.error(`[omx-bridge] failed to read discovered project root registry ${path}: ${error?.message || error}`);
    }
    return [];
  }
}

function pruneDiscoveredProjectRootRecords(records = [], options = {}) {
  const nowMs = Date.parse(isoNow(options));
  const retentionMs = discoveredProjectRootRetentionMs(options);
  const maxRoots = discoveredProjectRootMax(options);
  const byRoot = new Map();
  for (const record of records) {
    const root = canonicalProjectRoot(record.root);
    const lastSeenAt = record.lastSeenAt || isoNow(options);
    const lastSeenMs = Date.parse(lastSeenAt);
    if (!root || !hasOmxLogs(root)) continue;
    if (Number.isFinite(nowMs) && Number.isFinite(lastSeenMs) && nowMs - lastSeenMs > retentionMs) continue;
    const previous = byRoot.get(root);
    const previousMs = Date.parse(previous?.lastSeenAt || '');
    if (!previous || !Number.isFinite(previousMs) || lastSeenMs >= previousMs) {
      byRoot.set(root, { root, lastSeenAt, source: record.source || 'discovered' });
    }
  }
  return [...byRoot.values()]
    .sort((left, right) => Date.parse(right.lastSeenAt || '') - Date.parse(left.lastSeenAt || ''))
    .slice(0, maxRoots);
}

async function writeDiscoveredProjectRootRecords(projectRoot, records = [], options = {}) {
  if (!rememberDiscoveredProjectRoots(options)) return;
  const path = discoveredProjectRootsPath(projectRoot, options);
  const pruned = pruneDiscoveredProjectRootRecords(records, options);
  await ensureDirFor(path);
  await writeFile(path, JSON.stringify({ roots: pruned, updatedAt: isoNow(options) }, null, 2), 'utf8');
}

function discoveredProjectRootRecordsEqual(left = [], right = []) {
  const normalize = (records) => records.map((record) => ({
    root: record.root,
    lastSeenAt: record.lastSeenAt,
    source: record.source || 'discovered',
  }));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function splitProjectRoots(value) {
  return String(value || '')
    .split(/[,\n]/)
    .flatMap((part) => part.split(delimiter))
    .map((part) => part.trim())
    .filter(Boolean);
}

function uniqueProjectRoots(values) {
  const seen = new Set();
  const roots = [];
  for (const value of values.flat().filter(Boolean)) {
    const root = canonicalProjectRoot(value);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

async function discoverProjectRoots(options = {}) {
  const base = options.projectRoot || process.cwd();
  const configured = Array.isArray(options.projectRoots) ? options.projectRoots : splitProjectRoots(options.projectRoots);
  const envRoots = splitProjectRoots(process.env.BRIDGE_PROJECT_ROOTS || process.env.BRIDGE_OMX_PROJECT_ROOTS || '');
  const discoverTmux = options.discoverTmuxProjectRoots === true
    || ['1', 'true', 'yes', 'on'].includes(String(process.env.BRIDGE_DISCOVER_TMUX_PROJECT_ROOTS || '').toLowerCase());
  const tmuxPanes = !discoverTmux
    ? []
    : listTmuxPanes().filter((pane) => !pane.paneDead && pane.paneCurrentPath);
  const tmuxSourceRoots = tmuxPanes.map((pane) => pane.paneCurrentPath);
  const tmuxRoots = tmuxSourceRoots.filter((root) => existsSync(projectOmxLogsDir(root)));
  const rememberedRecords = await readDiscoveredProjectRootRecords(base, options);
  const rememberedRoots = rememberedRecords.map((record) => record.root);
  const terminalPendingRecords = await readTerminalPendingProjectRootRecords(base, options);
  const terminalPendingRoots = terminalPendingRecords.map((record) => record.root);
  const madmaxRecords = await readMadmaxRunRootRecords(
    [base, configured, envRoots, rememberedRoots, tmuxSourceRoots, terminalPendingRoots],
    options,
  );
  const madmaxRoots = madmaxRecords.map((record) => record.root);
  const madmaxRootSet = new Set(uniqueProjectRoots(madmaxRoots));
  const terminalPendingRootSet = new Set(uniqueProjectRoots(terminalPendingRoots));
  const now = isoNow(options);
  const nowMs = Date.parse(now);
  const refreshMs = discoveredProjectRootRefreshMs(options);
  const tmuxRootSet = new Set(uniqueProjectRoots(tmuxRoots));
  const rootsToRemember = uniqueProjectRoots([base, configured, envRoots, tmuxRoots, madmaxRoots, terminalPendingRoots])
    .filter((root) => hasOmxLogs(root));
  if (rootsToRemember.length > 0) {
    const recordsByRoot = new Map(rememberedRecords.map((record) => [canonicalProjectRoot(record.root), record]));
    for (const root of rootsToRemember) {
      const previous = recordsByRoot.get(root);
      const previousMs = Date.parse(previous?.lastSeenAt || '');
      const shouldRefresh = !previous
        || !Number.isFinite(nowMs)
        || !Number.isFinite(previousMs)
        || nowMs - previousMs >= refreshMs;
      if (shouldRefresh) {
        recordsByRoot.set(root, {
          root,
          lastSeenAt: now,
          source: terminalPendingRootSet.has(root) ? 'event-index-terminal-pending' : madmaxRootSet.has(root) ? 'madmax-isolated' : tmuxRootSet.has(root) ? 'tmux' : 'configured',
        });
      }
    }
    const recordsToWrite = pruneDiscoveredProjectRootRecords([...recordsByRoot.values()], options);
    if (!discoveredProjectRootRecordsEqual(recordsToWrite, rememberedRecords)) {
      await writeDiscoveredProjectRootRecords(base, recordsToWrite, options);
    }
  }
  return uniqueProjectRoots([base, configured, envRoots, rememberedRoots, tmuxRoots, madmaxRoots, terminalPendingRoots]);
}

function withOmxProjectRoot(entry, projectRoot) {
  return { ...entry, omxProjectRoot: entry.omxProjectRoot || projectRoot };
}

export async function readSessionHistory(projectRoot = process.cwd()) {
  const sourceCwd = await sourceCwdForOmxRoot(projectRoot);
  const path = join(projectOmxLogsDir(projectRoot), 'session-history.jsonl');
  const lifecycle = await explicitOmxLifecycleOwnership(projectRoot);
  return (await readJsonl(path)).map((entry) => {
    const hasOmxLifecycle = isOwnedLifecycleEntry(entry, lifecycle.ownedSessionIds);
    const endedAt = asString(entry.ended_at);
    return {
      omxSessionId: asString(entry.session_id),
      codexSessionId: asString(entry.native_session_id) || asString(entry.session_id),
      startedAt: asString(entry.started_at),
      endedAt,
      endedAtSource: endedAt ? 'session-history' : null,
      endReason: endedAt ? (asString(entry.reason) || 'session_exit') : null,
      cwd: asString(entry.cwd) || sourceCwd,
      sourceCwd,
      pid: entry.pid,
      omxProjectRoot: projectRoot,
      hasOmxLifecycle,
      lifecycleOwner: hasOmxLifecycle ? 'omx' : null,
    };
  }).filter((entry) => entry.omxSessionId || entry.codexSessionId);
}


async function readCurrentSessionState(projectRoot) {
  const sourceCwd = await sourceCwdForOmxRoot(projectRoot);
  const statePath = join(projectRoot, '.omx', 'state', 'session.json');
  if (!existsSync(statePath)) return [];
  try {
    const record = JSON.parse(await readFile(statePath, 'utf8'));
    if (!record || typeof record !== 'object') return [];
    const lifecycle = await explicitOmxLifecycleOwnership(projectRoot);
    const stateSessionId = asString(record.session_id) || asString(record.native_session_id);
    const inheritedOwnedSessionId = inheritedOwnedSessionIdForCurrentState(record, lifecycle);
    const omxSessionId = inheritedOwnedSessionId || stateSessionId;
    const hasOmxLifecycle = lifecycle.ownedSessionIds.has(stateSessionId) || Boolean(inheritedOwnedSessionId);
    return [{
      omxSessionId,
      codexSessionId: asString(record.native_session_id) || asString(record.session_id),
      startedAt: lifecycle.startedAtBySessionId.get(omxSessionId) || asString(record.started_at),
      currentStateStartedAt: asString(record.started_at),
      cwd: asString(record.cwd) || sourceCwd,
      sourceCwd,
      pid: record.pid,
      omxProjectRoot: projectRoot,
      hasOmxLifecycle,
      lifecycleOwner: hasOmxLifecycle ? 'omx' : null,
      isCurrentState: true,
    }];
  } catch {
    return [];
  }
}

async function readOmxLifecycleLogRecords(projectRoot) {
  const logsDir = projectOmxLogsDir(projectRoot);
  const files = await listFilesRecursive(logsDir, (_path, name) => /^omx-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  const records = [];
  for (const file of files) records.push(...await readJsonl(file));
  return records;
}

function launchMarkerOwnedSessionId(records = [], metadata = null) {
  if (!metadata?.launcher || !/^omx(?:\s|$)/.test(String(metadata.launcher))) return null;
  const markerMs = Date.parse(metadata.createdAt || '');
  const starts = records
    .filter((record) => record.event === 'session_start' && !isNativeOnlyStartRecord(record) && asString(record.session_id))
    .map((record, index) => ({
      record,
      index,
      ms: Date.parse(record.timestamp || record._ts || ''),
    }))
    .filter(({ ms }) => !Number.isFinite(markerMs) || !Number.isFinite(ms) || ms >= markerMs - 5000)
    .sort((left, right) => {
      const leftMs = Number.isFinite(left.ms) ? left.ms : Number.POSITIVE_INFINITY;
      const rightMs = Number.isFinite(right.ms) ? right.ms : Number.POSITIVE_INFINITY;
      if (leftMs !== rightMs) return leftMs - rightMs;
      return left.index - right.index;
    });
  return asString(starts[0]?.record?.session_id);
}

async function explicitOmxLifecycleOwnership(projectRoot, records = null) {
  const logRecords = records || await readOmxLifecycleLogRecords(projectRoot);
  const ownedSessionIds = new Set();
  const ownedSessionIdByPid = new Map();
  const startedAtBySessionId = new Map();
  for (const record of logRecords) {
    const sessionId = asString(record.session_id);
    if (!sessionId) continue;
    if (record.event === 'session_start') {
      const startedAt = asString(record.timestamp) || asString(record._ts);
      if (startedAt && !startedAtBySessionId.has(sessionId)) startedAtBySessionId.set(sessionId, startedAt);
    }
    if (isOwnedReconcileRecord(record)) {
      ownedSessionIds.add(sessionId);
      mapSet(ownedSessionIdByPid, record.pid, sessionId);
    }
  }
  const launchOwned = launchMarkerOwnedSessionId(logRecords, await readMadmaxRunMetadata(projectRoot));
  if (launchOwned) ownedSessionIds.add(launchOwned);
  return { ownedSessionIds, ownedSessionIdByPid, startedAtBySessionId, primaryOwnedSessionId: firstSetValue(ownedSessionIds) };
}

async function readOmxStartEvents(projectRoot) {
  const sourceCwd = await sourceCwdForOmxRoot(projectRoot);
  const records = await readOmxLifecycleLogRecords(projectRoot);
  const lifecycle = await explicitOmxLifecycleOwnership(projectRoot, records);
  const replacedNativeIds = replacedNativeSessionIds(records);
  const byOmxSession = new Map();
  for (const record of records) {
    if (record.event !== 'session_start' && record.event !== 'session_start_reconciled' && record.event !== 'session_end') continue;
    const omxSessionId = asString(record.session_id);
    if (!omxSessionId) continue;
    if (isNativeOnlyStartRecord(record) && replacedNativeIds.has(omxSessionId)) continue;
    const previous = byOmxSession.get(omxSessionId) || {};
    const startedAt = record.event === 'session_start'
      ? asString(record.timestamp) || asString(record._ts)
      : previous.startedAt;
    const endedAt = record.event === 'session_end'
      ? asString(record.timestamp) || asString(record._ts)
      : previous.endedAt;
    const hasOmxLifecycle = lifecycle.ownedSessionIds.has(omxSessionId)
      || (record.event === 'session_end' && isOwnedLifecycleEntry(record, lifecycle.ownedSessionIds));
    byOmxSession.set(omxSessionId, mergeSessionEntry(previous, {
      omxSessionId,
      codexSessionId: asString(record.native_session_id) || previous.codexSessionId || omxSessionId,
      startedAt,
      endedAt,
      endedAtSource: record.event === 'session_end' && endedAt ? 'omx-log-session-end' : previous.endedAtSource,
      endReason: record.event === 'session_end' && endedAt ? (asString(record.reason) || 'session_exit') : previous.endReason,
      cwd: asString(record.cwd) || previous.cwd || sourceCwd,
      sourceCwd,
      pid: record.pid || previous.pid,
      omxProjectRoot: projectRoot,
      hasOmxLifecycle,
      lifecycleOwner: hasOmxLifecycle ? 'omx' : null,
    }));
  }
  return [...byOmxSession.values()];
}

async function readTmuxHookMappings(projectRoot) {
  const logsDir = projectOmxLogsDir(projectRoot);
  const files = await listFilesRecursive(logsDir, (_path, name) => /^tmux-hook-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  const paneById = new Map(listTmuxPanes().map((pane) => [pane.tmuxPaneId, pane]));
  const mappings = new Map();
  for (const file of files) {
    for (const record of await readJsonl(file)) {
      if (record.sent === false || record.dry_run === true || record.event === 'injection_skipped') continue;
      const threadId = asString(record.thread_id);
      const paneId = record.target && typeof record.target === 'object' ? asString(record.target.value) : null;
      if (!threadId || !paneId) continue;
      const pane = paneById.get(paneId);
      mappings.set(threadId, {
        tmuxPaneId: paneId,
        tmuxId: pane?.tmuxId || null,
        timestamp: asString(record.timestamp),
      });
    }
  }
  return mappings;
}

function tmuxPaneForPid(pid) {
  const parsedPid = Number.parseInt(pid, 10);
  if (!Number.isFinite(parsedPid) || parsedPid <= 0) return null;
  return listTmuxPanes().find((pane) => !pane.paneDead && pane.panePid === parsedPid) || null;
}

function processIsAlive(pid) {
  const parsedPid = Number.parseInt(pid, 10);
  if (!Number.isFinite(parsedPid) || parsedPid <= 0) return false;
  try {
    process.kill(parsedPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function hasKnownPid(pid) {
  const parsedPid = Number.parseInt(pid, 10);
  return Number.isFinite(parsedPid) && parsedPid > 0;
}

function observedEndedAtForOwnedLifecycle(entry = {}, log = null, hook = null, tmuxMatch = null, options = {}) {
  if (!observedSessionEndEnabled(options)) return null;
  if (entry.endedAt || entry.hasOmxLifecycle !== true || !entry.omxSessionId) return null;
  if (!entry.omxProjectRoot || !existsSync(madmaxRunMetadataPath(entry.omxProjectRoot))) return null;
  if (hook?.tmuxId || tmuxMatch) return null;
  if (!hasKnownPid(entry.pid)) return null;
  if (processIsAlive(entry.pid)) return null;

  const observedAt = isoNow(options);
  const observedMs = Date.parse(observedAt);
  const lastActivityAt = latestIso(
    latestCodexLogActivityAt(log || {}),
    entry.associatedCodexLogs?.map((associated) => associated.lastEventAt).filter(Boolean) || [],
    entry.startedAt,
  );
  const lastActivityMs = Date.parse(lastActivityAt || '');
  if (!Number.isFinite(observedMs) || !Number.isFinite(lastActivityMs)) return null;
  const ageMs = observedMs - lastActivityMs;
  if (ageMs < observedSessionEndGraceMs(options)) return null;
  if (ageMs > observedSessionEndLookbackMs(options)) return null;

  return {
    endedAt: observedAt,
    endedAtSource: 'bridge-observed-exit',
    endReason: 'bridge_observed_session_exit',
  };
}

function nearestTmuxForCwd(cwd, startedAt, options = {}) {
  const panes = listTmuxPanes().filter((pane) => !pane.paneDead && (!cwd || pane.paneCurrentPath === cwd));
  if (panes.length === 0) return null;
  if (!startedAt) return panes[0];
  const sessions = new Map(listTmuxSessions().map((session) => [session.tmuxId, session]));
  const targetMs = Date.parse(startedAt);
  if (!Number.isFinite(targetMs)) return panes[0];
  const best = panes
    .map((pane) => ({ pane, delta: Math.abs(Date.parse(sessions.get(pane.tmuxId)?.createdAt || '') - targetMs) }))
    .sort((a, b) => a.delta - b.delta)[0];
  if (!best || !Number.isFinite(best.delta)) return panes[0];
  return best.delta <= tmuxAttachMaxSkewMs(options) ? best.pane : null;
}

function codexLogWithinLifecycleWindow(log = {}, entry = {}, options = {}) {
  if (!log.codexSessionId || !log.startedAt || !entry.startedAt) return false;
  if (entry.cwd && log.cwd && canonicalProjectRoot(log.cwd) !== canonicalProjectRoot(entry.cwd)) return false;
  const logMs = Date.parse(log.startedAt);
  const startMs = Date.parse(entry.startedAt);
  const endMs = Date.parse(entry.endedAt || '');
  if (!Number.isFinite(logMs) || !Number.isFinite(startMs)) return false;
  const lowerBound = startMs - 5000;
  const upperBound = Number.isFinite(endMs)
    ? endMs + 30000
    : startMs + codexCwdAttachWindowMs(options);
  return logMs >= lowerBound && logMs <= upperBound;
}

function codexLogBelongsToActiveLifecycle(log = {}, entry = {}, fileStat = null) {
  if (!log.codexSessionId || !entry.startedAt) return false;
  if (entry.cwd && log.cwd && canonicalProjectRoot(log.cwd) !== canonicalProjectRoot(entry.cwd)) return false;
  if (log.runtimeOmxSessionId && entry.omxSessionId && log.runtimeOmxSessionId !== entry.omxSessionId) return false;
  if (log.runtimeOmxSessionId && entry.omxSessionId && log.runtimeOmxSessionId === entry.omxSessionId) return true;
  const lifecycleStartMs = Date.parse(entry.startedAt);
  const currentStateStartMs = Date.parse(entry.currentStateStartedAt || '');
  const startMs = Number.isFinite(currentStateStartMs) ? currentStateStartMs : lifecycleStartMs;
  if (!Number.isFinite(startMs)) return false;
  const activityMs = Date.parse(latestCodexLogActivityAt(log) || '');
  const mtimeMs = fileStat?.mtimeMs;
  return (Number.isFinite(activityMs) && activityMs >= startMs - 5000)
    || (Number.isFinite(mtimeMs) && mtimeMs >= startMs - 5000);
}

function associatedCodexLogRef({ file, log, activityAt }) {
  return {
    codexSessionId: log.codexSessionId,
    sessionLogPath: file,
    startedAt: log.startedAt,
    lastEventAt: activityAt,
    sessionLogOwnerMatch: codexLogOwnerMatchSource(log, { omxSessionId: log.runtimeOmxSessionId }),
    originator: log.originator || null,
    sessionSource: log.sessionSource || null,
    isAuxiliaryCodexLog: isAuxiliaryCodexLog(log),
  };
}

function codexLogWithinOwnedLifecycleWindow(log = {}, entry = {}, nextStartMs = null, options = {}) {
  if (log.runtimeOmxSessionId && entry.omxSessionId && log.runtimeOmxSessionId !== entry.omxSessionId) return false;
  return codexLogWithinLifecycleWindow(log, entry, options)
    && codexLogBeforeNextLifecycle(log, entry, nextStartMs);
}

async function attachActiveLifecycleCodexLogs(scanByCodex, codexFiles = [], hookMappings = new Map(), options = {}) {
  const entries = [...scanByCodex.entries()].filter(([, entry]) => (
    entry.hasOmxLifecycle === true
    && !entry.endedAt
    && entry.startedAt
    && entry.isCurrentState === true
    && (
      options.discoverTmuxProjectRoots === false
      || tmuxPaneForPid(entry.pid)
      || hookMappings.has(entry.codexSessionId)
      || nearestTmuxForCwd(entry.cwd, entry.startedAt, options)
    )
  ));
  if (entries.length === 0) return;

  const limit = Math.min(codexFiles.length, codexCwdAttachScanLimit(options));
  const summaries = [];
  for (const file of codexFiles.slice(0, limit)) {
    const [log, fileStat] = await Promise.all([
      readCodexLogForBuild(file, options),
      stat(file).catch(() => null),
    ]);
    if (!log.codexSessionId || isAuxiliaryCodexLog(log)) continue;
    summaries.push({
      file,
      log,
      fileStat,
      activityAt: latestCodexLogActivityAt(log) || log.startedAt,
    });
  }

  const claimedFiles = new Set();
  const claimedCodexSessionIds = new Set();
  const nextStarts = nextLifecycleStartsByEntryKey(entries);
  for (const [key, entry] of entries) {
    const nextStartMs = nextStarts.get(key);
    const candidates = summaries
      .filter(({ file, log, fileStat }) => (
        !claimedFiles.has(file)
        && !claimedCodexSessionIds.has(log.codexSessionId)
        && codexLogBelongsToActiveLifecycle(log, entry, fileStat)
        && codexLogBeforeNextLifecycle(log, entry, nextStartMs)
      ))
      .sort((left, right) => {
        const leftOwner = codexLogOwnerMatchSource(left.log, entry) ? 1 : 0;
        const rightOwner = codexLogOwnerMatchSource(right.log, entry) ? 1 : 0;
        if (leftOwner !== rightOwner) return rightOwner - leftOwner;
        const activityDelta = sortableMs(right.activityAt) - sortableMs(left.activityAt);
        if (activityDelta !== 0) return activityDelta;
        return sortableMs(right.log.startedAt) - sortableMs(left.log.startedAt);
      });
    if (candidates.length === 0) continue;

    const ownerCandidates = candidates.filter(({ log }) => codexLogOwnerMatchSource(log, entry));
    const primaryCandidates = ownerCandidates.length > 0 ? ownerCandidates : candidates;
    const currentStateStartMs = Date.parse(entry.currentStateStartedAt || '');
    const primary = primaryCandidates
      .filter(({ log }) => {
        const logStartMs = Date.parse(log.startedAt || '');
        return Number.isFinite(currentStateStartMs)
          && Number.isFinite(logStartMs)
          && logStartMs >= currentStateStartMs - 5000;
      })
      .sort((left, right) => sortableMs(right.log.startedAt) - sortableMs(left.log.startedAt))[0]
      || primaryCandidates[0];
    claimedFiles.add(primary.file);
    claimedCodexSessionIds.add(primary.log.codexSessionId);
    const sessionLogOwnerMatch = codexLogOwnerMatchSource(primary.log, entry);
    scanByCodex.set(key, mergeSessionEntry(entry, {
      codexSessionId: primary.log.codexSessionId,
      sessionLogPath: primary.file,
      log: primary.log,
      ...codexLogAttachmentMetadata(entry, primary.log, 'active-codex-log'),
      sessionLogOwnerMatch,
      runtimeOmxSessionId: primary.log.runtimeOmxSessionId,
      runtimeTmuxId: primary.log.runtimeTmuxId,
      associatedCodexLogs: primaryCandidates.map(({ file, log, activityAt }) => ({
        ...associatedCodexLogRef({ file, log, activityAt }),
        sessionLogOwnerMatch: codexLogOwnerMatchSource(log, entry),
      })),
    }));
  }
}

async function attachRuntimeOwnedCodexLogs(scanByCodex, codexFiles = [], options = {}) {
  const entries = [...scanByCodex.entries()].filter(([, entry]) => (
    entry.hasOmxLifecycle === true
    && !entry.endedAt
    && entry.omxSessionId
  ));
  if (entries.length === 0) return;

  const limit = Math.min(codexFiles.length, codexCwdAttachScanLimit(options));
  const summaries = [];
  for (const file of codexFiles.slice(0, limit)) {
    const log = await readCodexLogForBuild(file, options);
    if (!log.codexSessionId || isAuxiliaryCodexLog(log)) continue;
    if (!log.runtimeOmxSessionId) continue;
    summaries.push({
      file,
      log,
      activityAt: latestCodexLogActivityAt(log) || log.startedAt,
    });
  }

  const claimedShadowCodexSessionIds = new Set();
  for (const [key, entry] of entries) {
    const candidates = summaries
      .filter(({ log }) => log.runtimeOmxSessionId === entry.omxSessionId)
      .sort((left, right) => {
        const activityDelta = sortableMs(right.activityAt) - sortableMs(left.activityAt);
        if (activityDelta !== 0) return activityDelta;
        return sortableMs(right.log.startedAt) - sortableMs(left.log.startedAt);
      });
    if (candidates.length === 0) continue;

    const primary = candidates[0];
    const sessionLogOwnerMatch = codexLogOwnerMatchSource(primary.log, entry);
    for (const candidate of candidates) claimedShadowCodexSessionIds.add(candidate.log.codexSessionId);
    scanByCodex.set(key, mergeSessionEntry(entry, {
      codexSessionId: primary.log.codexSessionId,
      sessionLogPath: primary.file,
      log: primary.log,
      sessionLogMatchSource: 'runtime-omx-session',
      sessionLogOwnerMatch,
      runtimeOmxSessionId: primary.log.runtimeOmxSessionId,
      runtimeTmuxId: primary.log.runtimeTmuxId,
      associatedCodexLogs: mergeAssociatedCodexLogs(
        candidates.map(({ file, log, activityAt }) => ({
          ...associatedCodexLogRef({ file, log, activityAt }),
          sessionLogOwnerMatch: codexLogOwnerMatchSource(log, entry),
        })),
        entry.associatedCodexLogs || [],
      ),
    }));
  }

  for (const codexSessionId of claimedShadowCodexSessionIds) {
    const shadow = scanByCodex.get(codexSessionId);
    if (shadow && shadow.hasOmxLifecycle !== true) scanByCodex.delete(codexSessionId);
  }
}

async function attachCodexLogsByLifecycleWindow(scanByCodex, codexFiles = [], directLogPaths = new Set(), options = {}) {
  const currentActiveOmxIds = new Set([...scanByCodex.values()]
    .filter((entry) => (
      entry.hasOmxLifecycle === true
      && entry.isCurrentState === true
      && !entry.endedAt
      && entry.omxSessionId
    ))
    .map((entry) => entry.omxSessionId));
  const entriesNeedingLog = [...scanByCodex.entries()].filter(([, entry]) => (
    entry.hasOmxLifecycle === true
    && !entry.sessionLogPath
    && (!entry.codexSessionId || !entry.omxSessionId || entry.codexSessionId === entry.omxSessionId)
    && !(entry.isCurrentState !== true && entry.omxSessionId && currentActiveOmxIds.has(entry.omxSessionId))
    && !directLogPaths.has(entry.sessionLogPath)
  ));
  if (entriesNeedingLog.length === 0) return new Set();

  const summaries = [];
  const limit = Math.min(codexFiles.length, codexCwdAttachScanLimit(options));
  for (const file of codexFiles.slice(0, limit)) {
    if (directLogPaths.has(file)) continue;
    const log = await readCodexLogForBuild(file, options);
    if (!log.codexSessionId || !log.startedAt || isAuxiliaryCodexLog(log)) continue;
    summaries.push({ file, log });
  }

  const claimedLogIds = new Set();
  const claimedFiles = new Set();
  const nextStarts = nextLifecycleStartsByEntryKey(entriesNeedingLog);
  for (const [key, entry] of entriesNeedingLog) {
    const nextStartMs = nextStarts.get(key);
    const candidates = summaries
      .filter(({ file, log }) => (
        !claimedFiles.has(file)
        && codexLogWithinOwnedLifecycleWindow(log, entry, nextStartMs, options)
      ))
      .sort((left, right) => Math.abs(Date.parse(left.log.startedAt) - Date.parse(entry.startedAt || ''))
        - Math.abs(Date.parse(right.log.startedAt) - Date.parse(entry.startedAt || '')));
    const ownerCandidates = candidates.filter(({ log }) => codexLogOwnerMatchSource(log, entry));
    const match = ownerCandidates[0] || candidates[0];
    if (!match) continue;
    claimedFiles.add(match.file);
    claimedLogIds.add(match.log.codexSessionId);
    scanByCodex.set(key, mergeSessionEntry(entry, {
      codexSessionId: match.log.codexSessionId,
      sessionLogPath: match.file,
      log: match.log,
      sessionLogMatchSource: 'cwd-start-window',
    }));
  }
  return claimedLogIds;
}

export async function buildSessionIndex(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const rawReadCodexLog = typeof options.readCodexLogFn === 'function' ? options.readCodexLogFn : readCodexLog;
  const codexLogCache = new Map();
  const buildOptions = {
    ...options,
    readCodexLogFn: async (file) => {
      if (!codexLogCache.has(file)) codexLogCache.set(file, rawReadCodexLog(file));
      return codexLogCache.get(file);
    },
  };
  const projectRoots = await discoverProjectRoots(buildOptions);
  const history = (await Promise.all(projectRoots.map(async (root) => (await readSessionHistory(root)).map((entry) => withOmxProjectRoot(entry, root))))).flat();
  const starts = (await Promise.all(projectRoots.map(async (root) => (await readOmxStartEvents(root)).map((entry) => withOmxProjectRoot(entry, root))))).flat();
  const current = (await Promise.all(projectRoots.map(async (root) => (await readCurrentSessionState(root)).map((entry) => withOmxProjectRoot(entry, root))))).flat();
  const hookMappings = new Map();
  for (const root of projectRoots) {
    for (const [threadId, mapping] of (await readTmuxHookMappings(root)).entries()) {
      hookMappings.set(threadId, mapping);
    }
  }
  const byCodex = new Map();

  for (const entry of [...history, ...starts, ...current]) {
    const key = sessionIndexKey(entry);
    if (!key) continue;
    const previous = byCodex.get(key) || {};
    byCodex.set(key, mergeSessionEntry(previous, entry));
  }

  const codexFiles = await listCodexSessionLogPaths(buildOptions);
  await attachRecentCodexLogsById(byCodex, codexFiles, buildOptions);
  const scanByCodex = limitPreReadSessions(byCodex, hookMappings, buildOptions);

  const codexFileByNameFragment = new Map();
  for (const file of codexFiles) {
    for (const id of scanByCodex.keys()) {
      if (file.includes(id) && !codexFileByNameFragment.has(id)) {
        codexFileByNameFragment.set(id, file);
      }
    }
  }
  const cwdAttachedLogIds = await attachCodexLogsByLifecycleWindow(
    scanByCodex,
    codexFiles,
    new Set(codexFileByNameFragment.values()),
    buildOptions,
  );
  await attachActiveLifecycleCodexLogs(scanByCodex, codexFiles, hookMappings, buildOptions);
  await attachRuntimeOwnedCodexLogs(scanByCodex, codexFiles, buildOptions);
  removeOwnedCodexShadowSessions(scanByCodex);

  if (options.includeUnmappedCodexLogs) {
    const scanLimit = Number.isFinite(buildOptions.unmappedCodexLogLimit) ? buildOptions.unmappedCodexLogLimit : 20;
    for (const file of codexFiles.slice(0, scanLimit)) {
      const log = await readCodexLogForBuild(file, buildOptions);
      if (!log.codexSessionId || isAuxiliaryCodexLog(log)) continue;
      if (cwdAttachedLogIds.has(log.codexSessionId)) continue;
      if ([...scanByCodex.values()].some((entry) => entry.hasOmxLifecycle === true && entry.codexSessionId === log.codexSessionId)) continue;
      if (buildOptions.cwd && log.cwd !== buildOptions.cwd) continue;
      const previous = scanByCodex.get(log.codexSessionId) || {};
      scanByCodex.set(log.codexSessionId, mergeSessionEntry(previous, {
        ...previous,
        codexSessionId: log.codexSessionId,
        startedAt: previous.startedAt || log.startedAt,
        cwd: previous.cwd || log.cwd,
        sessionLogPath: file,
        log,
      }));
    }
  }

  const currentOwnerCodexIds = new Set([...scanByCodex.values()]
    .filter((entry) => (
      entry.hasOmxLifecycle === true
      && !entry.endedAt
      && entry.omxSessionId
      && entry.codexSessionId
      && entry.omxSessionId !== entry.codexSessionId
    ))
    .map((entry) => entry.codexSessionId));

  const sessions = [];
  for (const [codexSessionId, entry] of scanByCodex.entries()) {
    const effectiveCodexSessionId = entry.codexSessionId || codexSessionId;
    const logPath = entry.sessionLogPath || codexFileByNameFragment.get(codexSessionId) || codexFileByNameFragment.get(effectiveCodexSessionId) || null;
    const log = entry.log || (logPath ? await readCodexLogForBuild(logPath, buildOptions) : null);
    if (
      log?.codexSessionId
      && effectiveCodexSessionId !== log.codexSessionId
      && [...scanByCodex.values()].some((candidate) => (
        candidate !== entry
        && candidate.hasOmxLifecycle === true
        && candidate.codexSessionId === log.codexSessionId
      ))
    ) {
      continue;
    }
    const hook = hookMappings.get(effectiveCodexSessionId) || hookMappings.get(codexSessionId);
    const cwd = entry.cwd || log?.cwd || entry.omxProjectRoot || null;
    const activityEntry = clearEndedAtForResumedCodexLog(entry, log || {}, { currentOwnerCodexIds });
    const tmuxMatch = activityEntry.endedAt
      ? null
      : (hook?.tmuxId ? hook : tmuxPaneForPid(activityEntry.pid) || nearestTmuxForCwd(cwd, activityEntry.startedAt || log?.startedAt, options));
    const observedEnd = observedEndedAtForOwnedLifecycle(activityEntry, log, hook, tmuxMatch, options);
    const effectiveEntry = observedEnd ? mergeSessionEntry(activityEntry, observedEnd) : activityEntry;
    const effectiveTmuxMatch = observedEnd ? null : tmuxMatch;
    const messageTimes = log?.messages?.map((message) => message.timestamp).filter(Boolean) || [];
    const associatedTimes = entry.associatedCodexLogs?.map((associated) => associated.lastEventAt).filter(Boolean) || [];
    const lastEventAt = latestIso(effectiveEntry.endedAt, effectiveEntry.startedAt, log?.startedAt, hook?.timestamp, messageTimes, associatedTimes);
    const projectCwd = projectCwdForSession(cwd, effectiveEntry.sourceCwd, effectiveEntry.omxProjectRoot);
    sessions.push({
      codexSessionId: effectiveCodexSessionId,
      threadId: effectiveCodexSessionId,
      omxSessionId: effectiveEntry.omxSessionId || codexSessionId,
      tmuxId: effectiveTmuxMatch?.tmuxId || null,
      tmuxPaneId: effectiveTmuxMatch?.tmuxPaneId || null,
      project: projectNameFromCwd(projectCwd),
      cwd,
      sourceCwd: effectiveEntry.sourceCwd || null,
      omxProjectRoot: effectiveEntry.omxProjectRoot || null,
      status: canonicalStatus(effectiveEntry, effectiveTmuxMatch),
      startedAt: effectiveEntry.startedAt || log?.startedAt || null,
      lastEventAt,
      sessionLogPath: logPath || null,
      sessionLogMatchSource: effectiveEntry.sessionLogMatchSource || (logPath ? 'id-fragment' : null),
      associatedCodexLogs: effectiveEntry.associatedCodexLogs || [],
      sessionLogOwnerMatch: effectiveEntry.sessionLogOwnerMatch || null,
      resumedCodexSession: effectiveEntry.resumedCodexSession === true || null,
      resumedCodexSessionStartedAt: effectiveEntry.resumedCodexSessionStartedAt || null,
      previousRuntimeOmxSessionId: effectiveEntry.previousRuntimeOmxSessionId || null,
      runtimeOmxSessionId: effectiveEntry.runtimeOmxSessionId || log?.runtimeOmxSessionId || null,
      runtimeTmuxId: effectiveEntry.runtimeTmuxId || log?.runtimeTmuxId || null,
      originator: effectiveEntry.originator || log?.originator || null,
      sessionSource: effectiveEntry.sessionSource || log?.sessionSource || null,
      isAuxiliaryCodexLog: isAuxiliaryCodexLog(log || effectiveEntry),
      hasOmxLifecycle: effectiveEntry.hasOmxLifecycle === true,
      lifecycleOwner: effectiveEntry.lifecycleOwner || null,
      endedAt: effectiveEntry.endedAt || null,
      endedAtSource: effectiveEntry.endedAtSource || null,
      endReason: effectiveEntry.endReason || null,
      approvalPolicy: log?.approvalPolicy || null,
      sandboxPolicyType: log?.sandboxPolicyType || null,
      permissionProfileType: log?.permissionProfileType || null,
    });
  }

  return dedupeSessions(sessions)
    .sort((a, b) => Date.parse(b.lastEventAt || b.startedAt || 0) - Date.parse(a.lastEventAt || a.startedAt || 0));
}

export function resolveSessionId(session, id) {
  return [session.codexSessionId, session.threadId, session.omxSessionId, session.tmuxId, session.tmuxPaneId]
    .filter(Boolean)
    .includes(id);
}

export async function getSessionById(id, options = {}) {
  const sessions = await buildSessionIndex(options);
  return sessions.find((session) => resolveSessionId(session, id)) || null;
}

export function sessionHistoryPath(projectRoot = process.cwd()) {
  return join(projectOmxLogsDir(projectRoot), 'session-history.jsonl');
}

export function hasProjectOmxLogs(projectRoot = process.cwd()) {
  return existsSync(projectOmxLogsDir(projectRoot));
}
