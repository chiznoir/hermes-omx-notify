import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordCodexHookPayload, readBridgeHookRecords, bridgeHookRecordToRouterEvents } from '../src/codex-hooks.js';

test('recordCodexHookPayload records session start lifecycle and hook event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-codex-hook-'));
  await recordCodexHookPayload({
    hook_event_name: 'SessionStart',
    session_id: 'codex-session-1',
    cwd: root,
    timestamp: '2026-05-31T12:00:00.000Z',
  }, { bridgeStateRoot: root, pid: 12345 });

  const history = await readFile(join(root, 'session-history.jsonl'), 'utf8');
  assert.match(history, /"event":"session_start"/);
  assert.match(history, /"lifecycle_owner":"bridge-hook"/);

  const records = await readBridgeHookRecords(root, { bridgeStateRoot: root });
  assert.equal(records.length, 1);
  assert.equal(records[0].event, 'session_start');
});

test('bridge hook turn complete maps to FinalAnswer and SessionIdle router events', async () => {
  const events = bridgeHookRecordToRouterEvents({
    event: 'turn_complete',
    session_id: 'codex-session-1',
    timestamp: '2026-05-31T12:01:00.000Z',
    text: '완료했습니다.',
    lineNumber: 7,
  });

  assert.equal(events[0].type, 'FinalAnswer');
  assert.equal(events[0].text, '완료했습니다.');
  assert.equal(events[1].type, 'SessionIdle');
});
