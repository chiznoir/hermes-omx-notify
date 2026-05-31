import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bridgeStatePath } from './bridge-paths.js';
import { readJsonl, listFilesRecursive } from './jsonl.js';

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nowIso() {
  return new Date().toISOString();
}

function statePath(name, options = {}) {
  return bridgeStatePath(name, options);
}

export function bridgeHookEventsDir(options = {}) {
  return options.hookEventsDir || process.env.BRIDGE_HOOK_EVENTS_DIR || statePath('hook-events', options);
}

export function bridgeHookEventLogPath(date = new Date().toISOString().slice(0, 10), options = {}) {
  return join(bridgeHookEventsDir(options), `codex-hook-${date}.jsonl`);
}

function hookEventName(payload = {}) {
  const explicit = asString(payload.hook_event_name)
    || asString(payload.hookEventName)
    || asString(payload.event)
    || asString(payload.name);
  if (explicit) return explicit;
  const type = String(payload.type || '').toLowerCase();
  if (type === '' || type === 'agent-turn-complete' || type === 'turn-complete') return 'Notify';
  return 'Unknown';
}

function payloadText(payload = {}) {
  const direct = asString(payload.prompt)
    || asString(payload.user_prompt)
    || asString(payload.userPrompt)
    || asString(payload['last-assistant-message'])
    || asString(payload.last_assistant_message)
    || asString(payload.message);
  if (direct) return direct;
  const input = payload.input_messages || payload.inputMessages || payload.messages;
  if (Array.isArray(input)) {
    const tail = input.map((item) => {
      if (typeof item === 'string') return item;
      const obj = asObject(item);
      return asString(obj.text) || asString(obj.content) || '';
    }).filter(Boolean).at(-1);
    return asString(tail);
  }
  return null;
}

function sessionIdFromPayload(payload = {}) {
  return asString(payload.session_id)
    || asString(payload['session-id'])
    || asString(payload.codex_session_id)
    || asString(payload.native_session_id)
    || asString(payload.thread_id)
    || asString(payload['thread-id']);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== ''));
}

export function normalizeCodexHookPayload(payload = {}, options = {}) {
  const eventName = hookEventName(payload);
  const timestamp = asString(payload.timestamp) || nowIso();
  const sessionId = sessionIdFromPayload(payload);
  const threadId = asString(payload.thread_id) || asString(payload['thread-id']);
  const turnId = asString(payload.turn_id) || asString(payload['turn-id']);
  const cwd = asString(payload.cwd) || asString(payload.project_path) || process.cwd();
  const text = payloadText(payload);
  const base = compactObject({
    source: 'codex-hook',
    hook_event_name: eventName,
    session_id: sessionId,
    native_session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    timestamp,
    cwd,
    pid: Number.isInteger(options.pid) ? options.pid : process.ppid,
    tmux_pane_id: asString(process.env.TMUX_PANE),
    transcript_path: asString(payload.transcript_path) || asString(payload.transcriptPath),
    lifecycle_owner: 'bridge-hook',
  });

  if (eventName === 'SessionStart') {
    return {
      lifecycle: {
        ...base,
        event: 'session_start',
        started_at: timestamp,
      },
      event: {
        ...base,
        event: 'session_start',
        text: text || 'Codex session started',
      },
    };
  }

  if (eventName === 'UserPromptSubmit') {
    return {
      event: {
        ...base,
        event: 'user_prompt_submit',
        text,
      },
    };
  }

  if (eventName === 'Stop') {
    return {
      event: {
        ...base,
        event: 'stop',
        text,
      },
    };
  }

  if (eventName === 'Notify') {
    return {
      event: {
        ...base,
        event: 'turn_complete',
        type: asString(payload.type) || 'agent-turn-complete',
        text,
      },
    };
  }

  return {
    event: {
      ...base,
      event: 'codex_hook_event',
      text,
    },
  };
}

async function appendJsonl(path, record) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function recordCodexHookPayload(payload = {}, options = {}) {
  const normalized = normalizeCodexHookPayload(payload, options);
  if (normalized.lifecycle) {
    await appendJsonl(options.sessionHistoryPath || process.env.BRIDGE_SESSION_HISTORY_PATH || statePath('session-history.jsonl', options), normalized.lifecycle);
  }
  if (normalized.event) {
    const date = (normalized.event.timestamp || nowIso()).slice(0, 10);
    await appendJsonl(bridgeHookEventLogPath(date, options), normalized.event);
  }
  return normalized;
}

export async function readBridgeHookRecords(_projectRoot = process.cwd(), options = {}) {
  const files = await listFilesRecursive(bridgeHookEventsDir(options), (_path, name) => /^codex-hook-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
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

export function bridgeHookRecordToRouterEvents(record = {}) {
  const sessionId = asString(record.session_id) || asString(record.native_session_id) || asString(record.thread_id) || 'unknown';
  const line = record.lineNumber || record.timestamp || record.event || 'hook';
  const common = {
    timestamp: asString(record.timestamp) || asString(record._ts),
    source: 'bridge-hook',
    backend: 'codex-hook',
  };
  const text = asString(record.text) || asString(record.message) || '';
  if (record.event === 'user_prompt_submit') {
    return [{
      ...common,
      eventId: `bridge-hook:${sessionId}:${line}:prompt`,
      type: 'CommandSubmitted',
      text,
      phase: 'user_prompt',
    }];
  }
  if (record.event === 'turn_complete') {
    const finalEvent = {
      ...common,
      eventId: `bridge-hook:${sessionId}:${line}:final`,
      type: 'FinalAnswer',
      text,
      phase: 'final_answer',
    };
    return [
      finalEvent,
      {
        ...common,
        eventId: `${finalEvent.eventId}:idle`,
        type: 'SessionIdle',
        text: '작업 완료. 다음 지시를 기다리는 상태입니다.',
        phase: 'idle',
      },
    ];
  }
  if (record.event === 'session_start') {
    return [{
      ...common,
      eventId: `bridge-hook:${sessionId}:${line}:start-observed`,
      type: 'BridgeLifecycle',
      text: text || 'Codex session start hook observed',
    }];
  }
  return [{
    ...common,
    eventId: `bridge-hook:${sessionId}:${line}`,
    type: 'BridgeHook',
    text: text || record.event || 'Codex hook event',
  }];
}
