import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBridgeCommands } from '../src/interactions.js';

test('readBridgeCommands ignores stale commands from reused tmux panes outside the session window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-interactions-'));
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'bridge-interactions.jsonl'), [
    {
      interactionId: 'stale-pane-command',
      codexSessionId: 'old-codex',
      omxSessionId: 'old-omx',
      threadId: 'old-codex',
      tmuxId: 'old-tmux',
      tmuxPaneId: '%58',
      commandText: '오래된 pane 명령',
      submittedAt: '2026-04-30T07:33:57.234Z',
      source: 'bridge',
    },
    {
      interactionId: 'current-pane-command',
      codexSessionId: 'current-codex',
      omxSessionId: 'current-omx',
      threadId: 'current-codex',
      tmuxId: 'current-tmux',
      tmuxPaneId: '%58',
      commandText: '현재 세션 명령',
      submittedAt: '2026-05-20T15:01:00.000Z',
      source: 'bridge',
    },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const commands = await readBridgeCommands({
    codexSessionId: 'current-codex',
    omxSessionId: 'current-omx',
    threadId: 'current-codex',
    tmuxId: 'current-tmux',
    tmuxPaneId: '%58',
    startedAt: '2026-05-20T15:00:30.000Z',
  }, { projectRoot: root });

  assert.deepEqual(commands.map((command) => command.interactionId), ['current-pane-command']);
});
