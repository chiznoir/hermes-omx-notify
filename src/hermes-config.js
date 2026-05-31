import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { expandHome } from './project-channels.js';

function truthyEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function positiveInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export function hermesConfigPath(options = {}) {
  return expandHome(
    options.hermesConfigPath
    || process.env.BRIDGE_HERMES_CONFIG
    || join(homedir(), '.hermes', 'config.yaml'),
  );
}

function parseCsv(value) {
  return String(value || '')
    .replace(/['"]/g, '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniq(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const item = String(value || '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function findDiscordBlock(lines) {
  const start = lines.findIndex((line) => /^discord:\s*(?:#.*)?$/.test(line));
  if (start < 0) return { start: -1, end: -1 };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S[^:]*:\s*(?:#.*)?$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function updateDiscordScalarList(lines, block, key, channelId) {
  const matcher = new RegExp(`^(\\s*)${key}:\\s*(.*)$`);
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = matcher.exec(lines[index]);
    if (!match) continue;
    const indent = match[1] || '  ';
    const indentWidth = indent.length;
    const continuation = [];
    for (let next = index + 1; next < block.end; next += 1) {
      const line = lines[next];
      if (!line.trim()) break;
      const nextIndent = (/^(\s*)/.exec(line)?.[1] || '').length;
      if (nextIndent <= indentWidth) break;
      continuation.push(line.trim());
    }
    const existing = parseCsv([match[2], ...continuation].join(' '));
    const changed = !existing.includes(channelId);
    if (!changed) return false;
    const values = uniq([...existing, channelId]);
    lines[index] = `${indent}${key}: ${values.join(',')}`;
    if (continuation.length > 0) {
      lines.splice(index + 1, continuation.length);
      block.end -= continuation.length;
    }
    return changed;
  }
  lines.splice(block.end, 0, `  ${key}: ${channelId}`);
  block.end += 1;
  return true;
}

export async function ensureHermesDiscordChannelAllowed(channelId, options = {}) {
  const id = String(channelId || '').trim();
  if (!id) return { ok: false, changed: false, reason: 'channelId is required' };
  const enabled = options.updateHermesConfig
    ?? truthyEnv(process.env.BRIDGE_HERMES_ALLOWLIST, false);
  if (!enabled) return { ok: true, changed: false, reason: 'disabled' };

  const path = hermesConfigPath(options);
  if (!path || !existsSync(path)) return { ok: false, changed: false, reason: 'missing-hermes-config', path };
  const original = await readFile(path, 'utf8');
  const lines = original.split(/\r?\n/);
  const block = findDiscordBlock(lines);
  if (block.start < 0) return { ok: false, changed: false, reason: 'missing-discord-config-block', path };

  const freeChanged = updateDiscordScalarList(lines, block, 'free_response_channels', id);
  const allowedChanged = updateDiscordScalarList(lines, block, 'allowed_channels', id);
  const changed = freeChanged || allowedChanged;
  if (!changed) return { ok: true, changed: false, path };

  await writeFile(path, `${lines.join('\n').replace(/\n*$/, '')}\n`, 'utf8');
  const restart = await restartHermesGatewayIfNeeded({ ...options, reason: 'hermes-channel-allowlist-updated' });
  return { ok: true, changed: true, path, restart };
}

export async function restartHermesGatewayIfNeeded(options = {}) {
  const enabled = options.restartHermesGateway
    ?? truthyEnv(process.env.BRIDGE_HERMES_RESTART, true);
  if (!enabled) return { ok: true, restarted: false, reason: 'disabled' };
  if (typeof options.hermesGatewayRestarter === 'function') {
    return options.hermesGatewayRestarter(options);
  }

  const command = String(
    options.hermesGatewayRestartCommand
    || process.env.BRIDGE_HERMES_RESTART_CMD
    || 'systemctl --user restart --no-block hermes-gateway.service',
  ).trim();
  if (!command) return { ok: true, restarted: false, reason: 'missing-command' };

  const child = spawn('/bin/sh', ['-lc', command], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { ok: true, restarted: true, command };
}

export function hermesHealthUrl(webhookUrl) {
  try {
    const url = new URL(webhookUrl);
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export async function waitForHermesGatewayAfterRestart(result = {}, webhookUrl, options = {}) {
  if (result?.restart?.restarted !== true) return { ok: true, waited: false, reason: 'not-restarted' };
  if (options.waitForHermesGatewayRestart === false) return { ok: true, waited: false, reason: 'disabled' };
  if (typeof options.fetchFn === 'function' && typeof options.hermesGatewayHealthFetchFn !== 'function') {
    return { ok: true, waited: false, reason: 'custom-fetch-no-health-probe' };
  }

  const url = options.hermesGatewayHealthUrl || hermesHealthUrl(webhookUrl);
  if (!url) return { ok: true, waited: false, reason: 'missing-health-url' };
  const fetchFn = options.hermesGatewayHealthFetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: true, waited: false, reason: 'fetch-unavailable' };

  const attempts = positiveInt(
    options.hermesGatewayHealthAttempts
      || process.env.BRIDGE_HERMES_GATEWAY_HEALTH_ATTEMPTS,
    20,
  );
  const delayMs = positiveInt(
    options.hermesGatewayHealthDelayMs
      || process.env.BRIDGE_HERMES_GATEWAY_HEALTH_DELAY_MS,
    250,
  );
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs);
    try {
      const res = await fetchFn(url, { method: 'GET' });
      if (res?.ok) return { ok: true, waited: true, attempts: attempt + 1, url };
      lastError = new Error(`Hermes gateway health failed: ${res?.status || 'unknown'}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Hermes gateway did not become healthy after allowlist restart: ${lastError?.message || 'unknown'}`);
}
