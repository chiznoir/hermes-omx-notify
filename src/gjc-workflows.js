import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { launchGjcTmuxSession } from './gjc-lifecycle.js';

const SOURCE_TYPES = new Set(['github_issue', 'github_pr_comment', 'discord_prompt', 'freeform_task']);
const TERMINAL_STATES = new Set(['completed', 'blocked', 'failed', 'cancelled']);

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function sha(value, length = 12) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function slugify(value, fallback = 'task') {
  return (String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)) || fallback;
}

function sourceTitle(source = {}) {
  if (source.url) return source.url.split('/').filter(Boolean).slice(-2).join('-');
  return source.text || source.type || 'task';
}

function workflowStorePath(projectRoot = process.cwd()) {
  return join(projectRoot, '.omx', 'state', 'gjc-workflows.json');
}

async function readWorkflowStore(projectRoot) {
  const path = workflowStorePath(projectRoot);
  const raw = await readFile(path, 'utf8').catch(() => '');
  if (!raw.trim()) return { version: 1, workflows: {} };
  const parsed = JSON.parse(raw);
  return {
    version: 1,
    workflows: parsed.workflows && typeof parsed.workflows === 'object' ? parsed.workflows : {},
  };
}

async function writeWorkflowStore(projectRoot, store) {
  const path = workflowStorePath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmp, path);
}

function commandList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanString).filter(Boolean);
}

function normalizedSource(body = {}) {
  const inferredType = body.issueUrl || body.issueNumber || body.repo ? 'github_issue' : body.sourceType;
  const raw = body.source && typeof body.source === 'object'
    ? body.source
    : {
      type: cleanString(inferredType) || 'freeform_task',
      url: body.issueUrl || body.url,
      text: body.task || body.prompt || body.text,
    };
  const type = cleanString(raw.type || raw.kind || body.sourceType) || 'freeform_task';
  return {
    type,
    url: cleanString(raw.url || body.issueUrl || body.url) || null,
    text: cleanString(raw.text || raw.body || body.task || body.prompt || body.text) || null,
  };
}

export function normalizeGjcWorkflowRequest(body = {}, options = {}) {
  const source = normalizedSource(body);
  if (!SOURCE_TYPES.has(source.type)) {
    return { ok: false, status: 400, error: `unsupported source.type: ${source.type}` };
  }
  if (!source.url && !source.text) {
    return { ok: false, status: 400, error: 'source.url or source.text is required' };
  }

  const mode = cleanString(body.mode) || 'verified-pr-only';
  if (mode !== 'verified-pr-only') {
    return { ok: false, status: 400, error: 'mode must be verified-pr-only' };
  }

  const targetRepoRaw = cleanString(body.targetRepoPath) || cleanString(body.repoPath) || cleanString(body.cwd);
  if (!targetRepoRaw) {
    return { ok: false, status: 400, error: 'targetRepoPath is required' };
  }
  const targetRepoPath = resolve(targetRepoRaw);

  const verificationCommands = commandList(body.verificationCommands || body.checks);
  if (verificationCommands.length === 0) {
    return { ok: false, status: 400, error: 'verificationCommands must include at least one command' };
  }

  const baseRef = cleanString(body.baseRef) || 'HEAD';
  const sourceKey = sha(`${source.type}:${source.url || source.text}`);
  const workflowId = cleanString(body.workflowId) || `gjcwf-${sourceKey}`;
  const branchName = cleanString(body.branchName)
    || `gjc/${slugify(sourceTitle(source), 'task')}-${sourceKey.slice(0, 8)}`;
  if (branchName.includes('..') || branchName.startsWith('/') || branchName.endsWith('/')) {
    return { ok: false, status: 400, error: 'branchName is unsafe' };
  }
  const defaultWorktree = join(dirname(targetRepoPath), '.gjc-worktrees', `${basename(targetRepoPath)}-${sourceKey.slice(0, 8)}`);
  const worktreePath = resolve(cleanString(body.worktreePath) || cleanString(body.worktree) || defaultWorktree);

  return {
    ok: true,
    request: {
      workflowId,
      source,
      mode,
      targetRepoPath,
      baseRef,
      branchName,
      worktreePath,
      verificationCommands,
      dryRun: body.dryRun === true,
      createdBy: cleanString(body.createdBy) || cleanString(body.sourceActor) || null,
      notificationTarget: body.notificationTarget || null,
    },
  };
}

export function workflowLockKeyFromBody(body = {}, options = {}) {
  const normalized = normalizeGjcWorkflowRequest(body, options);
  if (normalized.ok) return `gjc-workflow:${normalized.request.workflowId}`;
  const source = normalizedSource(body);
  return `gjc-workflow:${sha(`${source.type}:${source.url || source.text || randomUUID()}`)}`;
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || null,
  };
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function prepareWorkflowWorktree(request, options = {}) {
  if (typeof options.prepareWorkflowWorktreeFn === 'function') {
    return options.prepareWorkflowWorktreeFn(request, options);
  }
  if (!isDirectory(request.targetRepoPath)) {
    return { ok: false, state: 'failed', reason: 'invalid-target-repo', error: 'targetRepoPath is not a directory' };
  }
  const root = runGit(['rev-parse', '--show-toplevel'], request.targetRepoPath);
  if (!root.ok) {
    return { ok: false, state: 'failed', reason: 'not-a-git-repo', error: root.stderr || root.error || 'targetRepoPath is not a git repo' };
  }
  if (existsSync(request.worktreePath)) {
    const status = runGit(['status', '--porcelain'], request.worktreePath);
    if (!status.ok) {
      return { ok: false, state: 'blocked', reason: 'worktree-conflict', error: status.stderr || 'existing worktree path is not a valid git worktree' };
    }
    if (status.stdout.trim()) {
      return { ok: false, state: 'blocked', reason: 'dirty-worktree', error: 'existing worktree has uncommitted changes' };
    }
    return { ok: true, reused: true, worktreePath: request.worktreePath, branchName: request.branchName };
  }
  mkdirSync(dirname(request.worktreePath), { recursive: true });
  const added = runGit(['worktree', 'add', '-b', request.branchName, request.worktreePath, request.baseRef], request.targetRepoPath);
  if (!added.ok) {
    return { ok: false, state: 'blocked', reason: 'worktree-add-failed', error: added.stderr || added.error || 'git worktree add failed' };
  }
  return { ok: true, reused: false, worktreePath: request.worktreePath, branchName: request.branchName };
}

export function buildGjcWorkflowPrompt(record = {}) {
  const checks = (record.verificationCommands || []).map((command) => `- ${command}`).join('\n');
  return [
    'You are GJC running under Hermes gjc-workflows external-runner control.',
    '',
    'Workflow:',
    '1. Run deep-interview when requirements are ambiguous; otherwise record why it can be skipped.',
    '2. Run ralplan before implementation.',
    '3. Run ultragoal/edits/tests according to the accepted plan.',
    '',
    'Hard constraints:',
    '- Do not modify GJC source.',
    '- Do not enable GJC HTTPS bridge control endpoints.',
    '- Do not start an RPC/SDK host.',
    '- Do not expose public network services.',
    '- Do not delete failed/blocked worktrees or logs.',
    '- Do not claim PR readiness unless verification passes.',
    '',
    `Source type: ${record.source?.type}`,
    `Source URL: ${record.source?.url || ''}`,
    `Task text: ${record.source?.text || ''}`,
    `Repo: ${record.targetRepoPath}`,
    `Worktree: ${record.worktreePath}`,
    `Branch: ${record.branchName}`,
    '',
    'Verification commands Hermes will rerun before commit/PR:',
    checks,
    '',
    'Final answer must include this fenced machine-readable block:',
    '```',
    'GJC_WORKFLOW_RESULT',
    JSON.stringify({
      version: 1,
      status: 'success|blocked|failed',
      issueUrl: record.source?.url || null,
      branch: record.branchName,
      checks: (record.verificationCommands || []).map((command) => ({ command, status: 'passed|failed|not-run' })),
      summary: '<short summary>',
      nextAction: '<none or required follow-up>',
    }, null, 2),
    '```',
  ].join('\n');
}

function extractFirstJsonObject(text, start) {
  const open = text.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  return null;
}

export function parseGjcWorkflowResult(text = '') {
  const marker = text.indexOf('GJC_WORKFLOW_RESULT');
  if (marker < 0) return { ok: false, status: 'blocked', reason: 'missing-result-marker' };
  const raw = extractFirstJsonObject(text, marker);
  if (!raw) return { ok: false, status: 'blocked', reason: 'missing-result-json' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1) return { ok: false, status: 'blocked', reason: 'unsupported-result-version', result: parsed };
    if (!['success', 'blocked', 'failed'].includes(parsed.status)) {
      return { ok: false, status: 'blocked', reason: 'invalid-result-status', result: parsed };
    }
    if (!cleanString(parsed.branch)) return { ok: false, status: 'blocked', reason: 'missing-result-branch', result: parsed };
    if (!cleanString(parsed.summary)) return { ok: false, status: 'blocked', reason: 'missing-result-summary', result: parsed };
    if (!cleanString(parsed.nextAction)) return { ok: false, status: 'blocked', reason: 'missing-result-next-action', result: parsed };
    if (!Array.isArray(parsed.checks)) return { ok: false, status: 'blocked', reason: 'missing-result-checks', result: parsed };
    const invalidCheck = parsed.checks.some((check) => {
      return !check || !cleanString(check.command) || !['passed', 'failed', 'not-run'].includes(check.status);
    });
    if (invalidCheck) return { ok: false, status: 'blocked', reason: 'invalid-result-checks', result: parsed };
    return { ok: parsed.status === 'success', status: parsed.status, result: parsed };
  } catch (error) {
    return { ok: false, status: 'blocked', reason: 'invalid-result-json', error: error.message };
  }
}

function baseRecord(request, now = new Date().toISOString()) {
  return {
    workflowId: request.workflowId,
    source: request.source,
    mode: request.mode,
    targetRepoPath: request.targetRepoPath,
    baseRef: request.baseRef,
    branchName: request.branchName,
    worktreePath: request.worktreePath,
    state: 'queued',
    phase: 'queued',
    verificationCommands: request.verificationCommands,
    resultBlock: null,
    verificationEvidence: [],
    linkedBridgeSessionId: null,
    linkedGjcSessionId: null,
    commitSha: null,
    prUrl: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    createdBy: request.createdBy,
    notificationTarget: request.notificationTarget,
  };
}

function mergeRecord(store, record) {
  store.workflows[record.workflowId] = record;
}

function updated(record, patch, now = new Date().toISOString()) {
  return { ...record, ...patch, updatedAt: now };
}

export async function createGjcWorkflow(body = {}, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const normalized = normalizeGjcWorkflowRequest(body, options);
  if (!normalized.ok) return normalized;
  const now = typeof options.nowFn === 'function' ? options.nowFn() : new Date().toISOString();
  const request = normalized.request;
  const store = await readWorkflowStore(projectRoot);
  const existing = store.workflows[request.workflowId];
  if (existing) {
    return { ok: true, status: 200, duplicate: true, workflow: existing };
  }

  let workflow = baseRecord(request, now);
  mergeRecord(store, workflow);
  await writeWorkflowStore(projectRoot, store);

  workflow = updated(workflow, { state: 'preparing_worktree', phase: 'worktree' }, now);
  mergeRecord(store, workflow);
  await writeWorkflowStore(projectRoot, store);

  const worktree = prepareWorkflowWorktree(request, options);
  workflow = updated(workflow, { worktree }, now);
  if (!worktree.ok) {
    workflow = updated(workflow, {
      state: worktree.state || 'blocked',
      phase: 'worktree',
      failureReason: worktree.reason || worktree.error,
    }, now);
    mergeRecord(store, workflow);
    await writeWorkflowStore(projectRoot, store);
    return { ok: false, status: worktree.state === 'failed' ? 502 : 409, workflow };
  }

  workflow = updated(workflow, { state: 'launching_gjc', phase: 'launch' }, now);
  mergeRecord(store, workflow);
  await writeWorkflowStore(projectRoot, store);

  const launchBody = {
    requestId: workflow.workflowId,
    cwd: request.targetRepoPath,
    worktree: request.worktreePath,
  };
  const launch = typeof options.launchGjcWorkflowSessionFn === 'function'
    ? await options.launchGjcWorkflowSessionFn(launchBody, options)
    : launchGjcTmuxSession(launchBody, options);
  workflow = updated(workflow, {
    launch,
    linkedBridgeSessionId: launch.gjcSessionId || launch.bridgeSessionId || null,
    linkedGjcSessionId: launch.gjcSessionId || null,
  }, now);
  if (!launch.ok) {
    workflow = updated(workflow, { state: 'failed', phase: 'launch', failureReason: launch.reason || launch.error }, now);
    mergeRecord(store, workflow);
    await writeWorkflowStore(projectRoot, store);
    return { ok: false, status: 502, workflow };
  }

  const prompt = buildGjcWorkflowPrompt(workflow);
  let dispatch = { ok: false, status: 'pending-session-discovery', reason: 'gjc session id not yet available' };
  if (typeof options.dispatchGjcWorkflowPromptFn === 'function') {
    dispatch = await options.dispatchGjcWorkflowPromptFn({ workflow, prompt, launch }, options);
  }
  workflow = updated(workflow, {
    state: dispatch.ok ? 'executing' : 'launching_gjc',
    phase: dispatch.ok ? 'executing' : 'waiting-for-session-discovery',
    pendingPrompt: dispatch.ok ? null : prompt,
    dispatch,
  }, now);
  mergeRecord(store, workflow);
  await writeWorkflowStore(projectRoot, store);
  return { ok: true, status: 202, workflow };
}

export async function getGjcWorkflow(workflowId, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const store = await readWorkflowStore(projectRoot);
  const workflow = store.workflows[workflowId];
  if (!workflow) return { ok: false, status: 404, error: 'workflow not found' };
  return { ok: true, status: 200, workflow };
}

function trimCommandOutput(value, maxLength = 8000) {
  const text = String(value || '');
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function runVerificationCommand(command, cwd) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10,
  });
  return {
    command,
    ok: result.status === 0,
    status: result.status,
    stdout: trimCommandOutput(result.stdout),
    stderr: trimCommandOutput(result.stderr),
    error: result.error?.message || null,
  };
}

async function verifyWorkflow(workflow, options = {}) {
  if (typeof options.verifyGjcWorkflowFn === 'function') {
    return options.verifyGjcWorkflowFn(workflow, options);
  }
  const results = workflow.verificationCommands.map((command) => runVerificationCommand(command, workflow.worktreePath));
  return {
    ok: results.every((result) => result.ok),
    results,
  };
}

function resultCoversVerificationCommands(workflow, result) {
  const checks = new Map((result.checks || []).map((check) => [check.command, check.status]));
  const missing = workflow.verificationCommands.filter((command) => checks.get(command) !== 'passed');
  return {
    ok: missing.length === 0,
    missing,
  };
}

export async function completeGjcWorkflow(workflowId, body = {}, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const store = await readWorkflowStore(projectRoot);
  const workflow = store.workflows[workflowId];
  if (!workflow) return { ok: false, status: 404, error: 'workflow not found' };
  if (TERMINAL_STATES.has(workflow.state)) return { ok: true, status: 200, workflow };

  const finalText = cleanString(body.finalText || body.resultText || body.text);
  if (!finalText) return { ok: false, status: 400, error: 'finalText is required' };

  const now = typeof options.nowFn === 'function' ? options.nowFn() : new Date().toISOString();
  const parsed = parseGjcWorkflowResult(finalText);
  let next = updated(workflow, {
    phase: 'result',
    resultBlock: parsed.result || null,
    resultParse: parsed,
  }, now);

  if (!parsed.ok) {
    next = updated(next, {
      state: parsed.status || 'blocked',
      phase: 'result',
      failureReason: parsed.reason || parsed.status,
    }, now);
    mergeRecord(store, next);
    await writeWorkflowStore(projectRoot, store);
    return { ok: false, status: 409, workflow: next };
  }

  const resultCoverage = resultCoversVerificationCommands(next, parsed.result);
  if (!resultCoverage.ok) {
    next = updated(next, {
      state: 'blocked',
      phase: 'result',
      failureReason: 'result-checks-incomplete',
      resultCoverage,
    }, now);
    mergeRecord(store, next);
    await writeWorkflowStore(projectRoot, store);
    return { ok: false, status: 409, workflow: next };
  }

  next = updated(next, { state: 'verifying', phase: 'verification' }, now);
  mergeRecord(store, next);
  await writeWorkflowStore(projectRoot, store);

  const verification = await verifyWorkflow(next, options);
  next = updated(next, { verificationEvidence: verification.results || [], verification }, now);
  if (!verification.ok) {
    next = updated(next, {
      state: 'failed',
      phase: 'verification',
      failureReason: 'verification-failed',
    }, now);
    mergeRecord(store, next);
    await writeWorkflowStore(projectRoot, store);
    return { ok: false, status: 409, workflow: next };
  }

  next = updated(next, {
    state: 'completed',
    phase: 'verified',
    failureReason: null,
    commitSha: cleanString(body.commitSha) || next.resultBlock?.commitSha || null,
    prUrl: cleanString(body.prUrl) || next.resultBlock?.prUrl || null,
  }, now);
  mergeRecord(store, next);
  await writeWorkflowStore(projectRoot, store);
  return { ok: true, status: 200, workflow: next };
}

export async function cancelGjcWorkflow(workflowId, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const store = await readWorkflowStore(projectRoot);
  const workflow = store.workflows[workflowId];
  if (!workflow) return { ok: false, status: 404, error: 'workflow not found' };
  if (TERMINAL_STATES.has(workflow.state)) return { ok: true, status: 200, workflow };
  const hasLinkedSession = Boolean(
    workflow.linkedBridgeSessionId
    || workflow.linkedGjcSessionId
    || workflow.launch?.tmuxId
    || workflow.launch?.tmuxPaneId
  );
  const stopped = typeof options.stopGjcWorkflowSessionFn === 'function'
    ? await options.stopGjcWorkflowSessionFn(workflow, options)
    : {
      ok: !hasLinkedSession,
      skipped: true,
      reason: hasLinkedSession ? 'no workflow stop hook configured' : 'no linked session to stop',
    };
  if (!stopped.ok) {
    const next = updated(workflow, {
      phase: 'cancel',
      stop: stopped,
      failureReason: stopped.reason || stopped.error || 'workflow stop failed',
    });
    mergeRecord(store, next);
    await writeWorkflowStore(projectRoot, store);
    return { ok: false, status: 502, error: next.failureReason, workflow: next };
  }
  const next = updated(workflow, { state: 'cancelled', phase: 'cancelled', stop: stopped });
  mergeRecord(store, next);
  await writeWorkflowStore(projectRoot, store);
  return { ok: true, status: 202, workflow: next };
}
