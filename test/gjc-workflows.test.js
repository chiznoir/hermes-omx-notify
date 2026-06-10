import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import {
  buildGjcWorkflowPrompt,
  normalizeGjcWorkflowRequest,
  parseGjcWorkflowResult,
} from '../src/gjc-workflows.js';

async function request(server, path, options = {}) {
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
    const json = await res.json();
    return { status: res.status, json };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gjc-workflows-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(join(repo, 'README.md'), '# fixture\n');
  return { root, repo };
}

function workflowBody(repo, overrides = {}) {
  return {
    source: { type: 'freeform_task', text: 'Add a status command' },
    targetRepoPath: repo,
    baseRef: 'HEAD',
    verificationCommands: ['npm test'],
    mode: 'verified-pr-only',
    ...overrides,
  };
}

function workflowResultText({ command, status = 'passed' }) {
  return [
    'done',
    '```',
    'GJC_WORKFLOW_RESULT',
    JSON.stringify({
      version: 1,
      status: 'success',
      issueUrl: null,
      branch: 'gjc/feature',
      checks: [{ command, status }],
      summary: 'implemented and tested',
      nextAction: 'none',
    }),
    '```',
  ].join('\n');
}

test('normalizeGjcWorkflowRequest generalizes source types while requiring verified gate inputs', async () => {
  const { repo } = await fixture();
  const normalized = normalizeGjcWorkflowRequest(workflowBody(repo, {
    source: { type: 'discord_prompt', text: '기능 추가해줘' },
  }));

  assert.equal(normalized.ok, true);
  assert.equal(normalized.request.source.type, 'discord_prompt');
  assert.match(normalized.request.workflowId, /^gjcwf-/);
  assert.match(normalized.request.branchName, /^gjc\//);
  assert.equal(normalized.request.verificationCommands[0], 'npm test');

  const missingChecks = normalizeGjcWorkflowRequest(workflowBody(repo, { verificationCommands: [] }));
  assert.equal(missingChecks.ok, false);
  assert.match(missingChecks.error, /verificationCommands/);

  const unsupported = normalizeGjcWorkflowRequest(workflowBody(repo, {
    source: { type: 'unknown_source', text: 'x' },
  }));
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /unsupported source/);
});

test('parseGjcWorkflowResult treats malformed or missing result as blocked, never success', () => {
  const ok = parseGjcWorkflowResult([
    'done',
    '```',
    'GJC_WORKFLOW_RESULT',
    JSON.stringify({
      version: 1,
      status: 'success',
      issueUrl: null,
      branch: 'gjc/task',
      checks: [{ command: 'npm test', status: 'passed' }],
      summary: 'ok',
      nextAction: 'none',
    }),
    '```',
  ].join('\n'));
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 'success');

  const missing = parseGjcWorkflowResult('plain final answer');
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.reason, 'missing-result-marker');

  const invalidStatus = parseGjcWorkflowResult('GJC_WORKFLOW_RESULT {"version":1,"status":"maybe"}');
  assert.equal(invalidStatus.ok, false);
  assert.equal(invalidStatus.status, 'blocked');
  assert.equal(invalidStatus.reason, 'invalid-result-status');

  const incompleteSuccess = parseGjcWorkflowResult('GJC_WORKFLOW_RESULT {"version":1,"status":"success"}');
  assert.equal(incompleteSuccess.ok, false);
  assert.equal(incompleteSuccess.reason, 'missing-result-branch');
});

test('POST /gjc/workflows creates a canonical workflow and dispatches the GJC prompt through injected hook', async () => {
  const { root, repo } = await fixture();
  const calls = { prepare: [], launch: [], dispatch: [] };
  const server = createServer({
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => {
      calls.prepare.push(request);
      return { ok: true, reused: false, worktreePath: request.worktreePath, branchName: request.branchName };
    },
    launchGjcWorkflowSessionFn: (body) => {
      calls.launch.push(body);
      return {
        ok: true,
        backend: 'gjc-tmux',
        reused: true,
        tmuxId: 'gjc-managed',
        tmuxPaneId: '%88',
        gjcSessionId: 'gjc-session-1',
        cwd: body.cwd,
        worktree: body.worktree,
      };
    },
    dispatchGjcWorkflowPromptFn: ({ workflow, prompt, launch }) => {
      calls.dispatch.push({ workflow, prompt, launch });
      return { ok: true, backend: 'tmux', target: '%88' };
    },
    nowFn: () => '2026-06-10T09:00:00.000Z',
  });

  const res = await request(server, '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, {
      workflowId: 'gjcwf-test-1',
      source: { type: 'github_issue', url: 'https://github.com/acme/repo/issues/42', text: 'Fix bug' },
    })),
  });

  assert.equal(res.status, 202);
  assert.equal(res.json.workflow.workflowId, 'gjcwf-test-1');
  assert.equal(res.json.workflow.state, 'executing');
  assert.equal(res.json.workflow.linkedGjcSessionId, 'gjc-session-1');
  assert.equal(calls.prepare.length, 1);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.launch[0].cwd, repo);
  assert.equal(calls.launch[0].worktree, res.json.workflow.worktreePath);
  assert.equal(calls.dispatch.length, 1);
  assert.match(calls.dispatch[0].prompt, /deep-interview/);
  assert.match(calls.dispatch[0].prompt, /ralplan/);
  assert.match(calls.dispatch[0].prompt, /ultragoal/);
  assert.match(calls.dispatch[0].prompt, /GJC_WORKFLOW_RESULT/);
  assert.equal(res.json.next.resultSource, 'gjc-jsonl');

  const store = JSON.parse(await readFile(join(root, '.omx', 'state', 'gjc-workflows.json'), 'utf8'));
  assert.equal(store.workflows['gjcwf-test-1'].state, 'executing');

  const audit = (await readFile(join(root, '.omx', 'logs', 'bridge-audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(audit.some((entry) => entry.eventType === 'gjc.workflow.accepted' && entry.workflowId === 'gjcwf-test-1'));
});

test('POST /gjc/workflows is idempotent for an active workflow and avoids duplicate launch', async () => {
  const { root, repo } = await fixture();
  let launches = 0;
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => {
      launches += 1;
      return { ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-dup' };
    },
  };
  const body = workflowBody(repo, { workflowId: 'gjcwf-dup' });

  const first = await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const second = await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate, true);
  assert.equal(launches, 1);
});

test('POST /gjc/workflows does not relaunch an existing terminal workflow id', async () => {
  const { root, repo } = await fixture();
  let launches = 0;
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => {
      launches += 1;
      return { ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-terminal' };
    },
    verifyGjcWorkflowFn: (workflow) => ({
      ok: true,
      results: workflow.verificationCommands.map((command) => ({ command, ok: true, status: 0 })),
    }),
  };
  const body = workflowBody(repo, { workflowId: 'gjcwf-terminal' });

  await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await request(createServer(serverOptions), '/gjc/workflows/gjcwf-terminal/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ finalText: workflowResultText({ command: 'npm test' }) }),
  });
  const retry = await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  assert.equal(retry.status, 200);
  assert.equal(retry.json.duplicate, true);
  assert.equal(retry.json.workflow.state, 'completed');
  assert.equal(launches, 1);
});

test('POST /gjc/workflows blocks dirty/conflicting worktree without cleanup or launch', async () => {
  const { root, repo } = await fixture();
  let launches = 0;
  const server = createServer({
    projectRoot: root,
    prepareWorkflowWorktreeFn: () => ({
      ok: false,
      state: 'blocked',
      reason: 'dirty-worktree',
      error: 'existing worktree has uncommitted changes',
    }),
    launchGjcWorkflowSessionFn: () => {
      launches += 1;
      return { ok: true };
    },
  });
  const res = await request(server, '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-dirty' })),
  });

  assert.equal(res.status, 409);
  assert.equal(res.json.workflow.state, 'blocked');
  assert.equal(res.json.workflow.failureReason, 'dirty-worktree');
  assert.equal(launches, 0);
});

test('GET and cancel /gjc/workflows/:id expose and terminate only the canonical workflow record', async () => {
  const { root, repo } = await fixture();
  const stops = [];
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-cancel' }),
    stopGjcWorkflowSessionFn: (workflow) => {
      stops.push(workflow.workflowId);
      return { ok: true, backend: 'tmux', target: workflow.linkedBridgeSessionId };
    },
  };

  await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-cancel' })),
  });

  const fetched = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-cancel');
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.workflow.workflowId, 'gjcwf-cancel');
  assert.equal(fetched.json.workflow.linkedGjcSessionId, 'gjc-session-cancel');

  const cancelled = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-cancel/cancel', { method: 'POST' });
  assert.equal(cancelled.status, 202);
  assert.equal(cancelled.json.workflow.state, 'cancelled');
  assert.deepEqual(stops, ['gjcwf-cancel']);

  const fetchedAgain = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-cancel');
  assert.equal(fetchedAgain.json.workflow.state, 'cancelled');
  assert.equal(fetchedAgain.json.workflow.stop.ok, true);
});

test('cancel does not mark a linked workflow cancelled when stop fails or is unavailable', async () => {
  const { root, repo } = await fixture();
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-no-stop' }),
  };

  await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-no-stop' })),
  });

  const cancelled = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-no-stop/cancel', { method: 'POST' });
  assert.equal(cancelled.status, 502);
  assert.notEqual(cancelled.json.workflow.state, 'cancelled');
  assert.equal(cancelled.json.workflow.failureReason, 'no workflow stop hook configured');
});

test('POST /gjc/workflows/:id/complete blocks malformed GJC results before verification', async () => {
  const { root, repo } = await fixture();
  let verifications = 0;
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-result' }),
    verifyGjcWorkflowFn: () => {
      verifications += 1;
      return { ok: true, results: [] };
    },
  };

  await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-result-blocked' })),
  });

  const completed = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-result-blocked/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ finalText: 'finished without machine-readable marker' }),
  });

  assert.equal(completed.status, 409);
  assert.equal(completed.json.workflow.state, 'blocked');
  assert.equal(completed.json.workflow.failureReason, 'missing-result-marker');
  assert.equal(verifications, 0);
});

test('POST /gjc/workflows/:id/complete blocks successful results that omit required checks', async () => {
  const { root, repo } = await fixture();
  let verifications = 0;
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-incomplete' }),
    verifyGjcWorkflowFn: () => {
      verifications += 1;
      return { ok: true, results: [] };
    },
  };

  await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-incomplete-checks' })),
  });

  const completed = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-incomplete-checks/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ finalText: workflowResultText({ command: 'npm run lint' }) }),
  });

  assert.equal(completed.status, 409);
  assert.equal(completed.json.workflow.state, 'blocked');
  assert.equal(completed.json.workflow.failureReason, 'result-checks-incomplete');
  assert.equal(verifications, 0);
});

test('POST /gjc/workflows/:id/complete reruns verification before marking workflow completed', async () => {
  const { root, repo } = await fixture();
  const verified = [];
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-verified' }),
    verifyGjcWorkflowFn: (workflow) => {
      verified.push(workflow.workflowId);
      return {
        ok: true,
        results: workflow.verificationCommands.map((command) => ({ command, ok: true, status: 0 })),
      };
    },
  };

  await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-verified' })),
  });

  const completed = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-verified/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ finalText: workflowResultText({ command: 'npm test' }) }),
  });

  assert.equal(completed.status, 200);
  assert.equal(completed.json.workflow.state, 'completed');
  assert.equal(completed.json.workflow.phase, 'verified');
  assert.deepEqual(verified, ['gjcwf-verified']);
  assert.equal(completed.json.workflow.verificationEvidence[0].command, 'npm test');
});

test('buildGjcWorkflowPrompt preserves verified-only and no-bridge constraints', () => {
  const prompt = buildGjcWorkflowPrompt({
    source: { type: 'freeform_task', text: 'Add feature' },
    targetRepoPath: '/repo',
    worktreePath: '/worktree',
    branchName: 'gjc/feature',
    verificationCommands: ['npm test'],
  });

  assert.match(prompt, /Do not modify GJC source/);
  assert.match(prompt, /Do not enable GJC HTTPS bridge/);
  assert.match(prompt, /Do not start an RPC\/SDK host/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /GJC_WORKFLOW_RESULT/);
});
