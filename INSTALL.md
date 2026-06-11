# INSTALL — Hermes tmux bridge

This file is written as a direct runbook for Hermes or another automation agent. Follow it from top to bottom and do not print secrets, tokens, or webhook URLs in the final report.

## Goal

Install a same-host `hermes-tmux-bridge` stack that provides:

1. `tm-new`, `tm-send`, and `tm-kill` helper CLIs on `PATH`.
2. The `hermes-tmux-bridge` Hermes skill.
3. The localhost bridge server as a systemd user service.
4. Optional Hermes Gateway webhook subscription for Discord delivery.

The default security posture is localhost-only. `HOST=127.0.0.1` and `PORT=3037` are built-in defaults, so the runtime env file should not repeat them unless they are intentionally changed.

If the bridge is reachable from Docker, LAN, a reverse proxy, or the public internet, require `OMX_BRIDGE_TOKEN` and pass it with `--token-file`.

Runtime env rule: write only enabled features, secrets/ids, and non-default overrides. Use `.env.example` for the required/recommended variable surface; do not copy default-only keys into systemd env.

## Prerequisites

Dependency criteria:

- Node.js **20+** and npm are required for the bridge server, tests, and package install.
- `tmux` is required for visible managed GJC sessions and for `tm-new` / `tm-kill`.
- `curl` is required for health checks, install validation, and helper CLI HTTP calls.
- `jq` is required for the bundled helper CLIs that parse bridge JSON or build JSON payloads, especially `tm-send` and `tm-kill`. Treat it as required when installing `tm-new`, `tm-send`, and `tm-kill` onto `PATH`.
- Hermes Gateway is required only for webhook/Discord push delivery. Agent bridge-only installs can run without it.

```bash
node --version   # must be >= 20
npm --version
curl --version
jq --version
tmux -V
```

Webhook mode also expects a local Hermes Gateway:

```bash
systemctl --user status hermes-gateway.service --no-pager || true
curl -sS http://127.0.0.1:8644/health || true
```

## Environment-specific inputs

Do not copy Discord or Hermes values from another machine. On each PC, the installing agent must discover or ask for the real local values before enabling webhook delivery:

- fallback Discord channel id (`--channel`)
- project Discord channel mapping (`--project <project>=<channel-id>`)
- Discord bot token and guild id, usually from the local Hermes/Gateway environment
- Hermes Gateway env file location, if it is not `~/.hermes/.env`
- bridge token and webhook secret file paths

If a value is missing, stop and ask the operator instead of inventing one. Report secret/token paths only; never print raw secret, token, webhook URL, or full env file contents.

## Clone and verify

```bash
git clone https://github.com/chiznoir/hermes-tmux-bridge.git
cd hermes-tmux-bridge
npm install
npm test
```

Read project instructions before changing anything. The core branch does not require a tracked `AGENTS.md`; if a local one exists, read it before editing:

```bash
if [ -f AGENTS.md ]; then sed -n '1,220p' AGENTS.md; fi
```


## Automatic install: agent bridge only

Use this when Hermes will query the bridge API directly and no automatic webhook push is required.

```bash
scripts/install-hermes-stack.sh \
  --non-interactive
```

This installs helper CLIs, the Hermes skill, and the bridge server. It does not create a Hermes Gateway webhook subscription.

## Automatic install: Hermes Gateway webhook sink

Use this when bridge events should be pushed to Hermes Gateway and delivered to Discord.

For the full recommended Discord setup, including per-session Discord threads and managed `tm-new --gjc` notifications, provide the Discord bot token and guild id as well as the fallback/project channel ids:

```bash
scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --restart \
  --threads \
  --channel <fallback-discord-channel-id> \
  --project <project-name>=<project-discord-channel-id> \
  --bot-token-file <discord-bot-token-file> \
  --guild <discord-guild-id> \
  --config ~/.hermes/config.yaml
```

Use `--bot-token <token>` only for a local interactive shell where the value will not be logged. Automation should prefer `--bot-token-file`. Add `--alert-channel <ops-discord-channel-id>` when delivery-dead alerts should go somewhere other than the fallback channel.

Before or immediately after this step, ensure Hermes Gateway has matching webhook env:

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=<same value as the bridge webhook secret file>
```

Hermes Gateway must already be installed and able to reach its configured Discord bot. The installer creates the bridge secret file when webhook mode is enabled, but it does not install Hermes Gateway or invent Discord credentials. Do not print the secret value. Report only the path.

With the full command above, the bridge service env should include only enabled non-defaults/secrets such as:

```env
BRIDGE_HERMES_WEBHOOK_ENABLED=true
BRIDGE_HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/tmux-bridge
BRIDGE_HERMES_WEBHOOK_SECRET=<same value as Hermes WEBHOOK_SECRET>
BRIDGE_HERMES_DEFAULT_CHANNEL_ID=<fallback-discord-channel-id>
BRIDGE_DISCORD_BOT_TOKEN=<from bot token file>
BRIDGE_DISCORD_GUILD_ID=<discord-guild-id>
BRIDGE_DISCORD_FAST_EVENTS_ENABLED=true
BRIDGE_DISCORD_AUTO_CREATE_THREADS=true
BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS=true
BRIDGE_HERMES_NOTIFICATION_MODE=direct
```

Do not add the raw token or secret to the final report. It is enough to report the token/secret file paths and that the service is active.

When a Hermes config path is available, the service env uses the short allowlist keys:

```env
BRIDGE_HERMES_CONFIG=~/.hermes/config.yaml
BRIDGE_HERMES_ALLOWLIST=true
BRIDGE_HERMES_RESTART=true
BRIDGE_HERMES_RESTART_CMD=systemctl --user restart --no-block hermes-gateway.service
```

The bridge treats YAML continuation-line allowlist entries as existing channels. Re-sending an already allowed channel is a no-op and must not rewrite `config.yaml` or restart Gateway.

## Manual install

If the stack installer cannot be used, run the pieces explicitly.

### 1. Install helper CLIs

```bash
scripts/install-omx-cli.sh --force
```

Optional target directory:

```bash
scripts/install-omx-cli.sh --force --dir "$HOME/.local/bin"
```

Confirm the target directory is on `PATH` for Hermes/Gateway workers:

```bash
command -v tm-new
command -v tm-send
command -v tm-kill
```

### 2. Install Hermes skill

```bash
scripts/install-hermes-skill.sh
systemctl --user restart hermes-gateway.service || true
```

### 3. Install bridge server

```bash
scripts/install-systemd-service.sh \
  --host 127.0.0.1 \
  --port 3037
```

For non-localhost exposure, generate a token and pass the token file:

```bash
mkdir -p ~/.config/hermes-tmux-bridge
openssl rand -hex 32 > ~/.config/hermes-tmux-bridge/bridge.token
chmod 600 ~/.config/hermes-tmux-bridge/bridge.token

scripts/install-systemd-service.sh \
  --host 127.0.0.1 \
  --port 3037 \
  --token-file ~/.config/hermes-tmux-bridge/bridge.token
```

### 4. Optional webhook sink

```bash
mkdir -p ~/.config/hermes-tmux-bridge
openssl rand -hex 32 > ~/.config/hermes-tmux-bridge/hermes-webhook.secret
chmod 600 ~/.config/hermes-tmux-bridge/hermes-webhook.secret

scripts/install-systemd-service.sh \
  --host 127.0.0.1 \
  --port 3037 \
  --sink \
  --sink-url http://127.0.0.1:8644/webhooks/tmux-bridge \
  --secret-file ~/.config/hermes-tmux-bridge/hermes-webhook.secret \
  --channel <fallback-discord-channel-id> \
  --config ~/.hermes/config.yaml
```

Prefer `scripts/install-hermes-stack.sh --webhook` when possible because it also manages the Hermes subscription prompt.

## Validation

```bash
systemctl --user status hermes-tmux-bridge.service --no-pager
curl -sS http://127.0.0.1:3037/health
curl -sS http://127.0.0.1:3037/sessions
command -v tm-new
command -v tm-send
command -v tm-kill
npm test
```

Webhook mode validation:

```bash
curl -sS http://127.0.0.1:8644/health
hermes webhook list | grep tmux-bridge
journalctl --user -u hermes-tmux-bridge.service --no-pager -n 100 | grep 'bridge Hermes webhook sink enabled'
```

Threaded Discord/GJC validation:

```bash
journalctl --user -u hermes-tmux-bridge.service --no-pager -n 100 | grep 'bridge Discord notifier enabled'
grep -E 'BRIDGE_DISCORD_(BOT_TOKEN|GUILD_ID|FAST_EVENTS_ENABLED|AUTO_CREATE_THREADS)' \
  ~/.config/systemd/user/hermes-tmux-bridge.service.d/override.conf
tm-new --gjc <project-dir>
```

The `tm-new --gjc` smoke test creates a real tmux session and may create real Discord notifications. If the operator does not want live Discord traffic, skip the smoke test and validate only service/env/health.

## Final report format

Report:

- `npm test` result.
- Bridge service status.
- `curl http://127.0.0.1:3037/health` result.
- Installed helper CLI paths from `command -v`.
- Hermes skill target path.
- Webhook status only if webhook mode was requested.

Do not report raw secrets, tokens, Discord webhook URLs, or full `.env` contents.
