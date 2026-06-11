import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFile = promisify(execFileCallback);
const legacyHelperHashes = {
  'omx-new': '26cf5acba826c6831721a674c92d260cd1dc3b5a936d42978f80bc869e6b2b0f',
  'omx-send': '0d988aa05f0a2214990b0af8ba270895c03b7c68b2720d75ce4af510c06dd0ee',
  'omx-kill': '5618748fac135610dce2185f449d67a0260a895b120bb2e9fdd5dda570d1f2e9',
  'tmux-new': '3a635c6a9d9433778d19ff7417b5dd3115de4854b6efc8eaf01eeaaacadb267e',
  'tmux-send': '790bcddae17086ba74d07203bcc0c61add5647e8773bb21fb6b734d4532ed0eb',
  'tmux-kill': 'c27a724af232a5f4a85eb5a1041d63fd010c244575143e3585c2c26708660df7',
};

async function seedLegacyHelperSymlinks(targetDir) {
  await mkdir(targetDir, { recursive: true });
  for (const name of ['omx-new', 'omx-send', 'omx-kill', 'tmux-new', 'tmux-send', 'tmux-kill']) {
    await symlink(join(process.cwd(), 'bin', name), join(targetDir, name));
  }
}

async function installLegacyHashFixture(env) {
  const fakeBin = join(env.HOME, 'fake-bin');
  await mkdir(fakeBin, { recursive: true });
  const realSha256sum = (await execFile('bash', ['-lc', 'command -v sha256sum'], { env })).stdout.trim();
  const cases = Object.entries(legacyHelperHashes)
    .map(([name, hash]) => `    ${name}) echo "${hash}  $file"; exit 0 ;;`)
    .join('\n');
  await writeFile(join(fakeBin, 'sha256sum'), `#!/usr/bin/env bash
set -euo pipefail
file="$1"
base="$(basename "$file")"
if grep -qx "managed legacy fixture: $base" "$file" 2>/dev/null; then
  case "$base" in
${cases}
  esac
fi
exec ${JSON.stringify(realSha256sum)} "$@"
`);
  await chmod(join(fakeBin, 'sha256sum'), 0o755);
  env.PATH = `${fakeBin}:${env.PATH}`;
}

async function seedLegacyHelperCopies(targetDir) {
  await mkdir(targetDir, { recursive: true });
  for (const name of Object.keys(legacyHelperHashes)) {
    const target = join(targetDir, name);
    await writeFile(target, `managed legacy fixture: ${name}\n`);
    await chmod(target, 0o755);
  }
}

async function assertPathAbsent(path) {
  await assert.rejects(lstat(path));
}

async function tempEnv() {
  const home = await mkdtemp(join(tmpdir(), 'hermes-tmux-bridge-install-'));
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    HOST: '',
    PORT: '',
    BRIDGE_HERMES_WEBHOOK_URL: '',
    BRIDGE_HERMES_WEBHOOK_SECRET: '',
    BRIDGE_HERMES_DEFAULT_CHANNEL_ID: '',
    BRIDGE_HERMES_PROJECT_CHANNEL_MAP: '',
    BRIDGE_DISCORD_BOT_TOKEN: '',
    BRIDGE_DISCORD_GUILD_ID: '',
    BRIDGE_DISCORD_AUTO_CREATE_THREADS: '',
    DISCORD_BOT_TOKEN: '',
    DISCORD_GUILD_ID: '',
    DISCORD_SERVER_ID: '',
  };
}

test('.env.example is safe to source and keeps recommended values opt-in', async () => {
  const env = await tempEnv();
  await execFile('bash', [
    '-lc',
    'set -euo pipefail; set -a; . ./.env.example; set +a; test -z "${BRIDGE_HERMES_WEBHOOK_ENABLED:-}"; test -z "${BRIDGE_DISCORD_BOT_TOKEN:-}"; test -z "${HOST:-}"; test -z "${PORT:-}"',
  ], { env, cwd: process.cwd(), maxBuffer: 1024 * 1024 });
});

test('install-systemd-service does not enable Hermes webhook sink from channel mapping alone', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-systemd-service.sh',
    '--dry-run',
    '--no-start',
    '--repo-root', process.cwd(),
    '--map', join(env.HOME, 'project-channels.json'),
    '--channel', 'fallback-channel',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.doesNotMatch(stdout, /BRIDGE_HERMES_WEBHOOK_ENABLED=true/);
  assert.doesNotMatch(stdout, /BRIDGE_HERMES_WEBHOOK_URL=/);
  assert.match(stdout, /Hermes sink:\s+false/);
});

test('install-systemd-service quotes PATH for systemd Environment entries', async () => {
  const env = await tempEnv();
  env.PATH = '/tmp/a path:/usr/bin:/bin';
  const { stdout } = await execFile('bash', [
    'scripts/install-systemd-service.sh',
    '--dry-run',
    '--no-start',
    '--repo-root', process.cwd(),
    '--npm', '/usr/bin/npm',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /Environment="PATH=\/tmp\/a path:\/usr\/bin:\/bin"/);
});

test('install-systemd-service enables Discord fast-path events with Hermes bot routing', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-systemd-service.sh',
    '--dry-run',
    '--no-start',
    '--repo-root', process.cwd(),
    '--sink',
    '--secret', 'secret',
    '--channel', 'fallback-channel',
    '--bot-token', 'secret-discord-token',
    '--guild', 'guild-1',
    '--alert-channel', '123456789012345678',
    '--mention-users', '456789012345678901',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.doesNotMatch(stdout, /^HOST=/m);
  assert.doesNotMatch(stdout, /^PORT=/m);
  assert.doesNotMatch(stdout, /^BRIDGE_PUBLIC_URL=/m);
  assert.doesNotMatch(stdout, /BRIDGE_HERMES_WEBHOOK_EVENT_TYPES=AskPermission,FinalAnswer/);
  assert.match(stdout, /BRIDGE_DISCORD_FAST_EVENTS_ENABLED=true/);
  assert.match(stdout, /BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS=true/);
  assert.match(stdout, /DISCORD_ALERT_CHANNEL_ID=123456789012345678/);
  assert.match(stdout, /BRIDGE_DISCORD_MENTION_USERS=456789012345678901/);
});

test('install-systemd-service can enable Discord session thread creation explicitly', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-systemd-service.sh',
    '--dry-run',
    '--no-start',
    '--repo-root', process.cwd(),
    '--sink',
    '--secret', 'secret',
    '--channel', 'fallback-channel',
    '--bot-token', 'secret-discord-token',
    '--guild', 'guild-1',
    '--threads',
    '--mention-users', '456789012345678901',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /BRIDGE_DISCORD_AUTO_CREATE_THREADS=true/);
});

test('install-systemd-service enables Hermes allowlist without default restart env noise', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-systemd-service.sh',
    '--dry-run',
    '--no-start',
    '--repo-root', process.cwd(),
    '--config', join(env.HOME, '.hermes', 'config.yaml'),
    '--restart-cmd', 'systemctl --user restart --no-block hermes-gateway.service',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.doesNotMatch(stdout, /BRIDGE_DISCORD_AUTO_CREATE_THREADS=true/);
  assert.doesNotMatch(stdout, /BRIDGE_HERMES_CONFIG=.*config\.yaml/);
  assert.match(stdout, /BRIDGE_HERMES_ALLOWLIST=true/);
  assert.doesNotMatch(stdout, /BRIDGE_HERMES_RESTART=true/);
  assert.doesNotMatch(stdout, /BRIDGE_HERMES_RESTART_CMD=systemctl --user restart --no-block hermes-gateway\.service/);
});


test('bin/install.sh installs only canonical tm helper symlinks', async () => {
  const env = await tempEnv();
  const targetDir = join(env.HOME, 'bin');
  await seedLegacyHelperSymlinks(targetDir);
  const { stdout } = await execFile('bash', [
    'bin/install.sh',
    '--dir', targetDir,
    '--force',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /Installed symlink: .*tm-new/);
  assert.match(stdout, /Installed symlink: .*tm-send/);
  assert.match(stdout, /Installed symlink: .*tm-kill/);
  assert.doesNotMatch(stdout, /omx-bootstrap|omx-status|omx-sync|omx-cleanup/);
  assert.equal(await readlink(join(targetDir, 'tm-new')), join(process.cwd(), 'bin', 'tm-new'));
  assert.equal(await readlink(join(targetDir, 'tm-send')), join(process.cwd(), 'bin', 'tm-send'));
  assert.equal(await readlink(join(targetDir, 'tm-kill')), join(process.cwd(), 'bin', 'tm-kill'));
  await assertPathAbsent(join(targetDir, 'omx-new'));
  await assertPathAbsent(join(targetDir, 'omx-send'));
  await assertPathAbsent(join(targetDir, 'omx-kill'));
  await assertPathAbsent(join(targetDir, 'tmux-new'));
  await assertPathAbsent(join(targetDir, 'tmux-send'));
  await assertPathAbsent(join(targetDir, 'tmux-kill'));
});

test('install-omx-cli installs canonical tm helper symlinks and leaves old aliases uninstalled', async () => {
  const env = await tempEnv();
  const targetDir = join(env.HOME, 'bin');
  await seedLegacyHelperSymlinks(targetDir);
  const { stdout } = await execFile('bash', [
    'scripts/install-omx-cli.sh',
    '--repo-root', process.cwd(),
    '--dir', targetDir,
    '--force',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /Installed symlink: .*tm-new/);
  assert.match(stdout, /Installed symlink: .*tm-send/);
  assert.match(stdout, /Installed symlink: .*tm-kill/);
  assert.equal(await readlink(join(targetDir, 'tm-new')), join(process.cwd(), 'bin', 'tm-new'));
  assert.equal(await readlink(join(targetDir, 'tm-send')), join(process.cwd(), 'bin', 'tm-send'));
  assert.equal(await readlink(join(targetDir, 'tm-kill')), join(process.cwd(), 'bin', 'tm-kill'));
  await assertPathAbsent(join(targetDir, 'omx-new'));
  await assertPathAbsent(join(targetDir, 'omx-send'));
  await assertPathAbsent(join(targetDir, 'omx-kill'));
  await assertPathAbsent(join(targetDir, 'tmux-new'));
  await assertPathAbsent(join(targetDir, 'tmux-send'));
  await assertPathAbsent(join(targetDir, 'tmux-kill'));
});

test('install-omx-cli removes known legacy copied helpers but preserves non-managed legacy files', async () => {
  const env = await tempEnv();
  const targetDir = join(env.HOME, 'bin');
  await installLegacyHashFixture(env);
  await seedLegacyHelperCopies(targetDir);
  await writeFile(join(targetDir, 'custom-note'), 'not touched\n');
  const { stdout } = await execFile('bash', [
    'scripts/install-omx-cli.sh',
    '--repo-root', process.cwd(),
    '--dir', targetDir,
    '--force',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /Removed legacy copied helper: .*omx-new/);
  assert.match(stdout, /Removed legacy copied helper: .*tmux-send/);
  for (const name of ['omx-new', 'omx-send', 'omx-kill', 'tmux-new', 'tmux-send', 'tmux-kill']) {
    await assertPathAbsent(join(targetDir, name));
  }
  assert.equal(await readFile(join(targetDir, 'custom-note'), 'utf8'), 'not touched\n');

  await writeFile(join(targetDir, 'tmux-send'), '#!/bin/sh\necho user-owned\n');
  const preserved = await execFile('bash', [
    'scripts/install-omx-cli.sh',
    '--repo-root', process.cwd(),
    '--dir', targetDir,
    '--force',
  ], { env, maxBuffer: 1024 * 1024 });
  assert.match(preserved.stdout, /Skipping non-managed legacy target: .*tmux-send/);
  assert.equal(await readFile(join(targetDir, 'tmux-send'), 'utf8'), '#!/bin/sh\necho user-owned\n');
});

test('apply-runtime dry-run shows the user service restart and health check plan', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/apply-runtime.sh',
    '--dry-run',
    '--name', 'test-bridge',
    '--port', '3999',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /scope: user/);
  assert.match(stdout, /service: test-bridge\.service/);
  assert.match(stdout, /\+ systemctl --user daemon-reload/);
  assert.match(stdout, /\+ systemctl --user restart test-bridge\.service/);
  assert.match(stdout, /http:\/\/127\.0\.0\.1:3999\/health/);
  assert.match(stdout, /\+ curl -fsS http:\/\/127\.0\.0\.1:3999\/health/);
});

test('apply-runtime can target a system service and skip health checks', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/apply-runtime.sh',
    '--dry-run',
    '--system',
    '--skip-health',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /scope: system/);
  assert.match(stdout, /health: skipped/);
  assert.match(stdout, /\+ systemctl daemon-reload/);
  assert.match(stdout, /\+ systemctl restart hermes-tmux-bridge\.service/);
  assert.doesNotMatch(stdout, /\+ curl/);
});

test('install-hermes-stack defaults to Hermes agent bridge without webhook sink', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-hermes-stack.sh',
    '--dry-run',
    '--non-interactive',
    '--no-start',
    '--repo-root', process.cwd(),
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /install-omx-cli\.sh/);
  assert.match(stdout, /--force/);
  assert.match(stdout, /Mode: Hermes agent bridge/);
  assert.match(stdout, /Helper CLIs:/);
  assert.match(stdout, /remove Hermes webhook subscription tmux-bridge/);
  assert.doesNotMatch(stdout, /--sink(?:\s|$)/);
  assert.doesNotMatch(stdout, /install\/update Hermes webhook subscription/);
});

test('install-hermes-stack only enables webhook sink when explicitly requested', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-hermes-stack.sh',
    '--dry-run',
    '--non-interactive',
    '--no-start',
    '--repo-root', process.cwd(),
    '--webhook',
    '--channel', 'fallback-channel',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /--sink(?:\s|$)/);
  assert.match(stdout, /install\/update Hermes webhook subscription tmux-bridge/);
  assert.match(stdout, /Mode: Hermes webhook sink/);
});

test('install-hermes-stack maps Hermes Discord env into bridge service defaults', async () => {
  const env = await tempEnv();
  const hermesHome = join(env.HOME, '.hermes');
  await mkdir(hermesHome, { recursive: true });
  await writeFile(join(hermesHome, '.env'), [
    'DISCORD_BOT_TOKEN=dummy-bot-token',
    'DISCORD_GUILD_ID=guild-1',
    'DISCORD_HOME_CHANNEL=fallback-channel',
    'DISCORD_ALERT_CHANNEL_ID=123456789012345678',
    '',
  ].join('\n'));

  const { stdout } = await execFile('bash', [
    'scripts/install-hermes-stack.sh',
    '--dry-run',
    '--webhook',
    '--non-interactive',
    '--no-start',
    '--repo-root', process.cwd(),
    '--hermes-home', hermesHome,
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /--bot-token \\<redacted\\>/);
  assert.match(stdout, /--guild guild-1/);
  assert.match(stdout, /--alert-channel 123456789012345678/);
  assert.match(stdout, /--channel fallback-channel/);
  assert.doesNotMatch(stdout, /dummy-bot-token/);
});

test('install-hermes-stack forwards Discord session thread creation to service installer', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-hermes-stack.sh',
    '--dry-run',
    '--webhook',
    '--non-interactive',
    '--no-start',
    '--repo-root', process.cwd(),
    '--channel', 'fallback-channel',
    '--bot-token', 'secret-discord-token',
    '--guild', 'guild-1',
    '--threads',
    '--mention-users', '456789012345678901',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /--threads/);
  assert.match(stdout, /--mention-users 456789012345678901/);
  assert.doesNotMatch(stdout, /secret-discord-token/);
});

test('core worktree does not expose extension helper scripts', async () => {
  const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node src/server.js');

  const binReadme = await readFile(join(process.cwd(), 'bin', 'README.md'), 'utf8');
  assert.match(binReadme, /tm-new/);
  assert.match(binReadme, /tm-send/);
  assert.match(binReadme, /tm-kill/);
  for (const removed of ['bootstrap', 'status', 'sync', 'cleanup'].map((name) => `omx-${name}`)) {
    assert.equal(binReadme.includes(removed), false);
  }
});

async function makeTmNewHarness() {
  const env = await tempEnv();
  const fakeBin = join(env.HOME, 'fake-bin');
  await mkdir(fakeBin, { recursive: true });
  const logPath = join(env.HOME, 'calls.log');
  const statePath = join(env.HOME, 'tmux-sessions');
  const optionPath = join(env.HOME, 'tmux-options');
  await writeFile(join(fakeBin, 'tmux'), `#!/usr/bin/env bash
set -euo pipefail
log=${JSON.stringify(logPath)}
state=${JSON.stringify(statePath)}
options=${JSON.stringify(optionPath)}
printf 'tmux:%s\n' "$*" >> "$log"
case "$1" in
  has-session)
    target=""
    while [[ $# -gt 0 ]]; do
      case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac
    done
    grep -Fxq "$target" "$state" 2>/dev/null
    ;;
  new-session)
    session=""
    while [[ $# -gt 0 ]]; do
      case "$1" in -s) session="$2"; shift 2 ;; *) shift ;; esac
    done
    [[ -n "$session" ]] && printf '%s\n' "$session" >> "$state"
    exit 0 ;;
  kill-session)
    target=""
    while [[ $# -gt 0 ]]; do
      case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac
    done
    if [[ -n "$target" ]]; then
      grep -Fxv "$target" "$state" > "$state.tmp" 2>/dev/null || true
      mv "$state.tmp" "$state"
    fi
    exit 0 ;;
  set-option)
    target=""
    opt=""
    value=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -t) target="$2"; shift 2 ;;
        -q) shift ;;
        @*) opt="$1"; value="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ -n "$target" && -n "$opt" ]] && printf '%s\t%s\t%s\n' "$target" "$opt" "$value" >> "$options"
    exit 0 ;;
  show-options)
    target=""
    opt=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -t) target="$2"; shift 2 ;;
        -*) shift ;;
        @*) opt="$1"; shift ;;
        *) shift ;;
      esac
    done
    awk -F '\t' -v t="$target" -v o="$opt" '$1==t && $2==o { v=$3 } END { if (v != "") print v }' "$options" 2>/dev/null
    exit 0 ;;
  list-panes) printf '%%1\n'; exit 0 ;;
  switch-client|attach-session) exit 0 ;;
  *) exit 0 ;;
esac
`);
  await writeFile(join(fakeBin, 'omx'), `#!/usr/bin/env bash
set -euo pipefail
printf 'omx:%s\n' "$*" >> ${JSON.stringify(logPath)}
exit 0
`);
  await writeFile(join(fakeBin, 'gjc'), `#!/usr/bin/env bash
set -euo pipefail
printf 'gjc:GJC_TMUX_SESSION=%s args=%s\n' "\${GJC_TMUX_SESSION:-}" "$*" >> ${JSON.stringify(logPath)}
if [[ -n "\${GJC_TMUX_SESSION:-}" ]]; then
  run_dir="$PWD"
  args=("$@")
  for ((i=0; i<\${#args[@]}; i++)); do
    if [[ "\${args[$i]}" == "--worktree" ]]; then
      run_dir="\${args[$((i+1))]}"
    fi
  done
  printf '%s\n' "$GJC_TMUX_SESSION" >> ${JSON.stringify(statePath)}
  tmux set-option -t "$GJC_TMUX_SESSION" -q @gjc-profile 1
  tmux set-option -t "$GJC_TMUX_SESSION" -q @gjc-branch gjc
  tmux set-option -t "$GJC_TMUX_SESSION" -q @gjc-branch-slug gjc
  tmux set-option -t "$GJC_TMUX_SESSION" -q @gjc-project "$(basename "$run_dir")"
  mkdir -p "$HOME/.gjc/agent/sessions/test"
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  printf '{"type":"session","id":"gjc-session-main","cwd":"%s","timestamp":"%s"}\n' "$run_dir" "$timestamp" > "$HOME/.gjc/agent/sessions/test/session.jsonl"
  if [[ "\${HERMES_TEST_DUPLICATE_GJC_LOG:-}" == "1" ]]; then
    mkdir -p "$HOME/.gjc/agent/sessions/duplicate"
    printf '{"type":"session","id":"gjc-session-main","cwd":"%s","timestamp":"%s"}\n' "$run_dir" "$timestamp" > "$HOME/.gjc/agent/sessions/duplicate/session.jsonl"
  fi
  if [[ "\${HERMES_TEST_GJC_CLOSE_AFTER_LAUNCH:-}" == "1" ]]; then
    grep -Fxv "$GJC_TMUX_SESSION" ${JSON.stringify(statePath)} > ${JSON.stringify(statePath)}.tmp 2>/dev/null || true
    mv ${JSON.stringify(statePath)}.tmp ${JSON.stringify(statePath)}
  fi
fi
exit 0
`);
  await writeFile(join(fakeBin, 'curl'), `#!/usr/bin/env bash
exit 0
`);
  for (const name of ['tmux', 'omx', 'gjc', 'curl']) await chmod(join(fakeBin, name), 0o755);
  env.PATH = `${fakeBin}:${env.PATH}`;
  env.OMX_BRIDGE_URL = 'http://127.0.0.1:3999';
  return { env, logPath };
}

async function readHarnessLog(logPath) {
  try { return await readFile(logPath, 'utf8'); }
  catch { return ''; }
}

test('tm-new defaults to OMX and supports reserved attach token a', async () => {
  const { env, logPath } = await makeTmNewHarness();
  const { stdout } = await execFile('bash', [
    'bin/tm-new', 'a', '.', '--name', 'omx-main', '--json', '--no-check', '--', 'a'
  ], { env, maxBuffer: 1024 * 1024 });
  const jsonLine = stdout.trim().split('\n').find((line) => line.startsWith('{'));
  const result = JSON.parse(jsonLine);
  const log = await readHarnessLog(logPath);

  assert.equal(result.backend, 'omx');
  assert.equal(result.attach, true);
  assert.equal(result.tmuxId, 'omx-main');
  assert.match(result.command, /omx --madmax --high/);
  assert.match(result.command, / a ?$/);
  assert.match(log, /tmux:new-session -d -s omx-main/);
  assert.match(log, /omx --madmax --high/);
  assert.match(log, /tmux:attach-session -t omx-main|tmux:switch-client -t omx-main/);
  assert.doesNotMatch(log, /^gjc:/m);
});

test('tm-new treats standalone a after project as attach and ./a as a path', async () => {
  const { env, logPath } = await makeTmNewHarness();
  const dirA = join(env.HOME, 'a');
  await mkdir(dirA, { recursive: true });

  const afterProject = await execFile('bash', [
    'bin/tm-new', env.HOME, 'a', '--name', 'omx-after', '--json', '--no-check'
  ], { env, maxBuffer: 1024 * 1024 });
  const afterJson = JSON.parse(afterProject.stdout.trim().split('\n').find((line) => line.startsWith('{')));
  assert.equal(afterJson.attach, true);
  assert.equal(afterJson.projectDir, env.HOME);

  const pathCase = await execFile('bash', [
    join(process.cwd(), 'bin', 'tm-new'), './a', '--name', 'omx-path', '--json', '--no-check'
  ], { env: { ...env, PWD: env.HOME }, cwd: env.HOME, maxBuffer: 1024 * 1024 });
  const pathJson = JSON.parse(pathCase.stdout.trim().split('\n').find((line) => line.startsWith('{')));
  assert.equal(pathJson.attach, false);
  assert.equal(pathJson.projectDir, dirA);

  const log = await readHarnessLog(logPath);
  assert.match(log, /tmux:new-session -d -s omx-after/);
  assert.match(log, /tmux:new-session -d -s omx-path/);
});

test('tm-new --gjc uses native gjc --tmux with worktree and attach shorthand', async () => {
  const { env, logPath } = await makeTmNewHarness();
  const worktree = join(env.HOME, 'task-worktree');
  await mkdir(worktree, { recursive: true });
  const { stdout } = await execFile('bash', [
    'bin/tm-new', '--gjc', '.', 'a', '--name', 'gjc-main', '--worktree', worktree, '--json', '--no-check', '--', '--model', 'opus'
  ], { env, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').find((line) => line.startsWith('{')));
  const log = await readHarnessLog(logPath);

  assert.equal(result.backend, 'gjc');
  assert.equal(result.managed, true);
  assert.equal(result.attach, true);
  assert.equal(result.tmuxId, 'gjc-main');
  assert.equal(result.worktree, worktree);
  assert.match(result.command, /GJC_LAUNCH_POLICY=tmux/);
  assert.match(result.command, /GJC_TMUX_SESSION=gjc-main/);
  assert.match(result.command, new RegExp(`gjc --tmux --worktree ${worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --model opus`));
  assert.match(log, new RegExp(`gjc:GJC_TMUX_SESSION=gjc-main args=--tmux --worktree ${worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --model opus`));
  assert.match(log, /tmux:set-option -t gjc-main -q @gjc-branch gjc/);
  assert.match(log, /tmux:set-option -t gjc-main -q @gjc-project task-worktree/);
  assert.match(log, /tmux:set-option -t gjc-main -q @gjc-session-id gjc-session-main/);
  assert.doesNotMatch(log, /tmux:new-session .*gjc/);
  assert.match(log, /tmux:attach-session -t gjc-main|tmux:switch-client -t gjc-main/);
});

test('tm-new --gjc attach treats a user-closed native GJC tmux session as normal', async () => {
  const { env, logPath } = await makeTmNewHarness();
  env.HERMES_TEST_GJC_CLOSE_AFTER_LAUNCH = '1';

  const { stdout, stderr } = await execFile('bash', [
    'bin/tm-new', 'a', '--gjc', '--name', 'gjc-closed', '--json', '--no-check'
  ], { env, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').find((line) => line.startsWith('{')));
  const log = await readHarnessLog(logPath);

  assert.equal(result.backend, 'gjc');
  assert.equal(result.attach, true);
  assert.equal(result.tmuxId, 'gjc-closed');
  assert.match(result.message, /ended before post-launch registration/);
  assert.doesNotMatch(stderr, /error:/);
  assert.match(log, /gjc:GJC_TMUX_SESSION=gjc-closed args=--tmux/);
  assert.doesNotMatch(log, /tmux:set-option -t gjc-closed -q @gjc-session-id/);
  assert.doesNotMatch(log, /tmux:attach-session -t gjc-closed|tmux:switch-client -t gjc-closed/);
});

test('tm-new --gjc rejects ambiguous duplicate new GJC logs even with the same id', async () => {
  const { env, logPath } = await makeTmNewHarness();
  const worktree = join(env.HOME, 'ambiguous-worktree');
  await mkdir(worktree, { recursive: true });

  await assert.rejects(
    execFile('bash', [
      'bin/tm-new', '--gjc', '.', '--name', 'gjc-ambiguous', '--worktree', worktree, '--json', '--no-check'
    ], { env: { ...env, HERMES_TEST_DUPLICATE_GJC_LOG: '1' }, maxBuffer: 1024 * 1024 }),
    /ambiguous new GJC session logs for gjc-ambiguous: .*gjc-session-main@.*duplicate.*gjc-session-main@.*test|ambiguous new GJC session logs for gjc-ambiguous: .*gjc-session-main@.*test.*gjc-session-main@.*duplicate/,
  );

  const log = await readHarnessLog(logPath);
  assert.match(log, /tmux:kill-session -t gjc-ambiguous/);
});

test('tm-new rejects GJC runs dir and GJC-only worktree misuse', async () => {
  const { env } = await makeTmNewHarness();
  await assert.rejects(
    execFile('bash', ['bin/tm-new', '--gjc', '--runs', '/tmp/runs', '--no-check'], { env, maxBuffer: 1024 * 1024 }),
    /--runs\/--runs-dir is not supported with --gjc/,
  );
  await assert.rejects(
    execFile('bash', ['bin/tm-new', '--gjc', '--direct', '--no-check'], { env, maxBuffer: 1024 * 1024 }),
    /--direct\/-d is not supported with --gjc/,
  );
  await assert.rejects(
    execFile('bash', ['bin/tm-new', '--worktree', '../task', '--no-check'], { env, maxBuffer: 1024 * 1024 }),
    /--worktree is only supported with --gjc/,
  );
});
