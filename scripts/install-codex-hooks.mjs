#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';

function usage() {
  console.log(`Install hermes-codex-notify Codex hook layer.\n\nUsage:\n  scripts/install-codex-hooks.sh [options]\n\nOptions:\n  --repo-root PATH     Bridge repository root (default: parent of scripts/)\n  --codex-home PATH    Codex home (default: CODEX_HOME or ~/.codex)\n  --state-root PATH    Bridge state root shared with the service\n  --force-notify       Replace an existing non-bridge Codex notify command\n  --no-notify          Do not manage the Codex notify command\n  --uninstall          Remove bridge hook entries managed by this repository\n  --dry-run            Print planned changes without writing\n  -h, --help           Show help`);
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function jsonCommand(scriptPath, stateRoot) {
  const prefix = stateRoot ? `BRIDGE_STATE_ROOT=${shellQuote(stateRoot)} ` : '';
  return `${prefix}node ${shellQuote(scriptPath)}`;
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function notifyCommandLine(scriptPath, stateRoot) {
  const parts = stateRoot
    ? ['env', `BRIDGE_STATE_ROOT=${stateRoot}`, 'node', scriptPath]
    : ['node', scriptPath];
  return `notify = [${parts.map(tomlString).join(', ')}]`;
}

function parseArgs(argv) {
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  const options = {
    repoRoot: resolve(scriptDir, '..'),
    codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'),
    stateRoot: '',
    forceNotify: false,
    manageNotify: true,
    uninstall: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--repo-root': options.repoRoot = argv[++i]; break;
      case '--codex-home': options.codexHome = argv[++i]; break;
      case '--state-root': options.stateRoot = argv[++i]; break;
      case '--force-notify': options.forceNotify = true; break;
      case '--no-notify': options.manageNotify = false; break;
      case '--uninstall': options.uninstall = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '-h':
      case '--help': usage(); process.exit(0); break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  options.repoRoot = resolve(expandHome(options.repoRoot));
  options.codexHome = resolve(expandHome(options.codexHome));
  if (options.stateRoot) options.stateRoot = resolve(expandHome(options.stateRoot));
  return options;
}

async function readText(path) {
  try { return await readFile(path, 'utf8'); }
  catch { return ''; }
}

function hookEntry(command, eventName) {
  const entry = { hooks: [{ type: 'command', command }] };
  if (eventName === 'SessionStart') entry.matcher = 'startup|resume|clear';
  if (eventName === 'Stop') entry.hooks[0].timeout = 10;
  return entry;
}

function isBridgeHookEntry(entry, scriptPath) {
  const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
  return hooks.some((hook) => String(hook?.command || '').includes(scriptPath));
}

function updateHooksJson(raw, command, scriptPath, uninstall) {
  let doc = {};
  if (raw.trim()) {
    try { doc = JSON.parse(raw); }
    catch { throw new Error('Codex hooks.json exists but is not valid JSON'); }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
  if (!doc.hooks || typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)) doc.hooks = {};
  const events = ['SessionStart', 'UserPromptSubmit', 'Stop'];
  for (const eventName of events) {
    const existing = Array.isArray(doc.hooks[eventName]) ? doc.hooks[eventName] : [];
    doc.hooks[eventName] = existing.filter((entry) => !isBridgeHookEntry(entry, scriptPath));
    if (!uninstall) doc.hooks[eventName].push(hookEntry(command, eventName));
    if (doc.hooks[eventName].length === 0) delete doc.hooks[eventName];
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function setTopLevelKey(raw, key, valueLine) {
  const lines = raw.split('\n');
  let sectionStart = lines.findIndex((line) => /^\s*\[/.test(line));
  if (sectionStart === -1) sectionStart = lines.length;
  for (let index = 0; index < sectionStart; index += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) {
      lines[index] = valueLine;
      return lines.join('\n');
    }
  }
  lines.splice(0, 0, valueLine);
  return lines.join('\n');
}

function removeTopLevelKey(raw, key, predicate = () => true) {
  const lines = raw.split('\n');
  let sectionStart = lines.findIndex((line) => /^\s*\[/.test(line));
  if (sectionStart === -1) sectionStart = lines.length;
  return lines.filter((line, index) => {
    if (index >= sectionStart) return true;
    if (!new RegExp(`^\\s*${key}\\s*=`).test(line)) return true;
    return !predicate(line);
  }).join('\n');
}

function topLevelValueLine(raw, key) {
  const lines = raw.split('\n');
  let sectionStart = lines.findIndex((line) => /^\s*\[/.test(line));
  if (sectionStart === -1) sectionStart = lines.length;
  return lines.slice(0, sectionStart).find((line) => new RegExp(`^\\s*${key}\\s*=`).test(line)) || null;
}

function updateConfigToml(raw, scriptPath, uninstall, manageNotify, forceNotify, stateRoot = '') {
  let next = raw;
  if (uninstall) {
    if (manageNotify) next = removeTopLevelKey(next, 'notify', (line) => line.includes(scriptPath));
    return next.trim() ? `${next.replace(/\n*$/, '')}\n` : '';
  }
  next = setTopLevelKey(next, 'hooks', 'hooks = true');
  if (!manageNotify) return `${next.replace(/\n*$/, '')}\n`;

  const existingNotify = topLevelValueLine(next, 'notify');
  if (existingNotify && !existingNotify.includes(scriptPath) && !forceNotify) {
    throw new Error('existing Codex notify command differs; re-run with --force-notify or --no-notify');
  }
  next = setTopLevelKey(next, 'notify', notifyCommandLine(scriptPath, stateRoot));
  return `${next.replace(/\n*$/, '')}\n`;
}

async function writePlanned(path, content, dryRun) {
  if (dryRun) {
    console.log(`\n--- ${path} ---`);
    process.stdout.write(content);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scriptPath = resolve(options.repoRoot, 'bin', 'bridge-codex-hook');
  if (!existsSync(scriptPath)) throw new Error(`missing hook script: ${scriptPath}`);
  const command = jsonCommand(scriptPath, options.stateRoot);
  const hooksPath = join(options.codexHome, 'hooks.json');
  const configPath = join(options.codexHome, 'config.toml');
  const hooksRaw = await readText(hooksPath);
  const configRaw = await readText(configPath);
  const hooksNext = updateHooksJson(hooksRaw, command, scriptPath, options.uninstall);
  const configNext = updateConfigToml(configRaw, scriptPath, options.uninstall, options.manageNotify, options.forceNotify, options.stateRoot);
  await writePlanned(hooksPath, hooksNext, options.dryRun);
  await writePlanned(configPath, configNext, options.dryRun);
  console.log(options.uninstall ? 'Codex bridge hooks removed.' : 'Codex bridge hooks installed.');
  if (options.dryRun) console.log('DRY-RUN: no files were written.');
}

main().catch((error) => {
  console.error(`install-codex-hooks: ${error.message}`);
  process.exit(1);
});
