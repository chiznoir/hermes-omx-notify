import { listFilesRecursive, readJsonl } from '../jsonl.js';
import { listTmuxPanes } from '../tmux.js';
import { omxLogsDir } from './omx-logs.js';

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export async function readTmuxHookRecords(projectRoot = process.cwd()) {
  const files = await listFilesRecursive(omxLogsDir(projectRoot), (_path, name) => /^tmux-hook-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
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

function shouldUseHookForPaneMapping(record = {}) {
  if (record.sent === false) return false;
  if (record.dry_run === true) return false;
  if (record.event === 'injection_skipped') return false;
  return true;
}

export async function readTmuxHookMappings(projectRoot = process.cwd()) {
  const paneById = new Map(listTmuxPanes().map((pane) => [pane.tmuxPaneId, pane]));
  const mappings = new Map();
  for (const record of await readTmuxHookRecords(projectRoot)) {
    if (!shouldUseHookForPaneMapping(record)) continue;
    const threadId = asString(record.thread_id);
    const paneId = record.target && typeof record.target === 'object' ? asString(record.target.value) : null;
    if (!threadId || !paneId) continue;
    const pane = paneById.get(paneId);
    mappings.set(threadId, {
      tmuxPaneId: paneId,
      tmuxId: pane?.tmuxId || null,
      timestamp: asString(record.timestamp),
      source: 'omx-hook',
    });
  }
  return mappings;
}

export function hookRecordToRouterEvent(record) {
  const threadId = asString(record.thread_id) || 'unknown';
  const paneId = record.target && typeof record.target === 'object' ? asString(record.target.value) : null;
  const timestamp = asString(record.timestamp) || asString(record._ts);
  return {
    eventId: `omx-hook:${threadId}:${record.lineNumber || timestamp || paneId || 'hook'}`,
    type: 'TmuxHook',
    timestamp,
    source: 'omx-hook',
    text: paneId ? `tmux target ${paneId}` : 'tmux hook event',
    backend: 'tmux',
  };
}
