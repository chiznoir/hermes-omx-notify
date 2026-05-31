import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listFilesRecursive, readJsonl } from '../jsonl.js';

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function omxLogsDir(projectRoot = process.cwd()) {
  return join(projectRoot, '.omx', 'logs');
}

export async function readOmxSessionHistory(projectRoot = process.cwd()) {
  const path = join(omxLogsDir(projectRoot), 'session-history.jsonl');
  return (await readJsonl(path)).map((entry) => ({
    omxSessionId: asString(entry.session_id),
    codexSessionId: asString(entry.native_session_id) || asString(entry.session_id),
    startedAt: asString(entry.started_at),
    endedAt: asString(entry.ended_at),
    cwd: asString(entry.cwd),
    pid: entry.pid,
    source: 'omx-log',
  })).filter((entry) => entry.omxSessionId || entry.codexSessionId);
}

export async function readCurrentOmxSession(projectRoot = process.cwd()) {
  const statePath = join(projectRoot, '.omx', 'state', 'session.json');
  if (!existsSync(statePath)) return [];
  try {
    const record = JSON.parse(await readFile(statePath, 'utf8'));
    if (!record || typeof record !== 'object') return [];
    return [{
      omxSessionId: asString(record.session_id) || asString(record.native_session_id),
      codexSessionId: asString(record.native_session_id) || asString(record.session_id),
      startedAt: asString(record.started_at),
      cwd: asString(record.cwd),
      pid: record.pid,
      source: 'omx-state',
    }].filter((entry) => entry.omxSessionId || entry.codexSessionId);
  } catch {
    return [];
  }
}

export async function readOmxLogRecords(projectRoot = process.cwd()) {
  const files = await listFilesRecursive(omxLogsDir(projectRoot), (_path, name) => /^omx-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  const records = [];
  for (const file of files) {
    let lineNumber = 0;
    for (const record of await readJsonl(file)) {
      lineNumber += 1;
      records.push({ ...record, sourceFile: file, lineNumber });
    }
  }
  return records;
}

export async function readOmxStartEvents(projectRoot = process.cwd()) {
  return (await readOmxLogRecords(projectRoot))
    .filter((record) => record.event === 'session_start')
    .map((record) => ({
      omxSessionId: asString(record.session_id),
      codexSessionId: asString(record.native_session_id) || asString(record.session_id),
      startedAt: asString(record.timestamp) || asString(record._ts),
      cwd: asString(record.cwd),
      pid: record.pid,
      source: 'omx-log',
    }))
    .filter((entry) => entry.omxSessionId || entry.codexSessionId);
}

export function omxRecordToRouterEvent(record) {
  const timestamp = asString(record.timestamp) || asString(record._ts);
  const sessionId = asString(record.native_session_id) || asString(record.session_id) || 'unknown';
  const eventName = asString(record.event) || 'omx_event';
  return {
    eventId: `omx-log:${sessionId}:${record.lineNumber || timestamp || eventName}`,
    type: eventName === 'session_start' ? 'SessionStart' : eventName === 'session_end' ? 'SessionEnd' : 'OmxEvent',
    timestamp,
    source: 'omx-log',
    text: record.message || record.command || eventName,
    backend: 'omx',
  };
}
