# Bridge + Hermes only install — agent runbook

**English** | [한국어](bridge-hermes-only-install-ko.md)

Use this runbook when a new PC or Hermes Agent should install only `hermes-omx-bridge` plus Hermes/Discord notification integration.

## Goal

The install is complete when only the following are working:

1. The `hermes-omx-bridge` server runs on `127.0.0.1:3037` as a systemd user service.
2. Hermes has the `hermes-omx-bridge`, `omx-new`, `omx-send`, and `omx-kill` skills installed.
3. The Hermes Gateway webhook subscription `omx-bridge` receives `AskPermission,FinalAnswer` events.
4. Notifications reach a Discord project channel or session thread.
5. The `omx-new`, `omx-send`, and `omx-kill` helper CLIs are on `PATH`.

The required helper CLIs are installed by `scripts/install-hermes-stack.sh`, which installs only `omx-new`, `omx-send`, and `omx-kill` for this path. To install only the CLIs, use `bin/install.sh --force` or `scripts/install-omx-cli.sh --force`.

## What this runbook does not install

These tools are outside this runbook:

- `omx-bootstrap`, `omx-status`, `omx-sync`, `omx-cleanup`
- AgentMemory / CodeGraph / RTK / Cognee / CLIProxy / caveman helper setup
- Codex global hook or MCP config changes

## Values the agent must get from the operator

Do not print secret values back to the screen. Report only file paths or whether a value was configured.

Required:

- Discord fallback channel ID: default notification channel ID.
- Discord bot token: bot token used by Hermes Gateway/bridge to send Discord messages.
- Discord guild/server ID.
- Hermes Gateway `WEBHOOK_SECRET` location or permission to configure it.

Recommended:

- Per-project Discord channel mapping, for example `hermes-omx-bridge=345678901234567890`.
- Discord user IDs to mention on `SessionStart`, for example `456789012345678901`.

Optional:

- Bridge bearer token: needed only when exposing the bridge through Docker, LAN, reverse proxy, or public access.
- Existing Hermes home path. The default is `~/.hermes`.

## Check prerequisites

```bash
node --version   # >= 20
npm --version
curl --version
jq --version
tmux -V
systemctl --user status hermes-gateway.service --no-pager || true
curl -sS http://127.0.0.1:8644/health || true
```

The Hermes Gateway webhook platform must be enabled. Gateway env must include the values below, and `WEBHOOK_SECRET` must match the secret file used by the bridge installer.

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=<same value as the bridge secret file>
```

Gateway env locations vary by install. The agent should ask the operator for the location instead of guessing.

## Clone and verify

```bash
git clone https://github.com/chiznoir/hermes-omx-bridge.git
cd hermes-omx-bridge
npm install
npm test
```

## Recommended install: include Hermes webhook notifications

This command installs the bridge service, Hermes skills, webhook subscription, and helper CLIs together.

```bash
scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --restart \
  --direct \
  --threads \
  --channel <fallback-discord-channel-id> \
  --project <project-name>=<project-discord-channel-id> \
  --bot-token '<discord-bot-token>' \
  --guild <discord-guild-or-server-id> \
  --mention-users <discord-user-id>
```

You can pass `--project` more than once.

```bash
scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --restart \
  --direct \
  --threads \
  --channel <fallback-discord-channel-id> \
  --project hermes-omx-bridge=<project-channel-id> \
  --project other-project=<other-project-channel-id> \
  --bot-token '<discord-bot-token>' \
  --guild <discord-guild-or-server-id> \
  --mention-users <discord-user-id>
```

If the bridge stays on the same host at `127.0.0.1`, the bridge bearer token can be empty. If it is exposed through Docker, LAN, a reverse proxy, or public access, create a token file and add `--token-file`.

```bash
mkdir -p ~/.config/hermes-omx-bridge
openssl rand -hex 32 > ~/.config/hermes-omx-bridge/bridge.token
chmod 600 ~/.config/hermes-omx-bridge/bridge.token

scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --restart \
  --direct \
  --threads \
  --channel <fallback-discord-channel-id> \
  --project <project-name>=<project-discord-channel-id> \
  --bot-token '<discord-bot-token>' \
  --guild <discord-guild-or-server-id> \
  --mention-users <discord-user-id> \
  --token-file ~/.config/hermes-omx-bridge/bridge.token
```

## Bridge-only mode where Hermes queries the API directly

If you do not need automatic Discord push notifications and Hermes only needs to query the bridge API, install without `--webhook`. This mode does not create a Hermes Gateway webhook subscription.

```bash
scripts/install-hermes-stack.sh --non-interactive --restart
```

In this mode, `FinalAnswer` / `AskPermission` automatic notifications will not be sent.

## Installed artifacts

```text
~/.local/bin/omx-new
~/.local/bin/omx-send
~/.local/bin/omx-kill
~/.hermes/skills/autonomous-ai-agents/hermes-omx-bridge/SKILL.md
~/.hermes/skills/autonomous-ai-agents/omx-new/SKILL.md
~/.hermes/skills/autonomous-ai-agents/omx-send/SKILL.md
~/.hermes/skills/autonomous-ai-agents/omx-kill/SKILL.md
~/.config/systemd/user/hermes-omx-bridge.service
~/.config/hermes-omx-bridge/hermes-omx-bridge.env
~/.config/hermes-omx-bridge/hermes-webhook.secret
~/.config/hermes-omx-bridge/project-channels.json
~/.hermes/webhook_subscriptions.json
```

## Verify

```bash
systemctl --user is-active hermes-omx-bridge.service
systemctl --user status hermes-omx-bridge.service --no-pager
curl -fsS http://127.0.0.1:3037/health | jq .

systemctl --user is-active hermes-gateway.service
curl -fsS http://127.0.0.1:8644/health | jq .

command -v omx-new omx-send omx-kill
hermes skills list | grep 'hermes-omx-bridge'
```

Also verify that the webhook subscription prompt is current. `FinalAnswer` remains the internal event type, but the user-facing title should be `Session Idle`.

```bash
python - <<'PY'
import json, os
p = os.path.expanduser('~/.hermes/webhook_subscriptions.json')
data = json.load(open(p))
sub = data.get('omx-bridge') or data.get('subscriptions', {}).get('omx-bridge')
prompt = sub.get('prompt', '') if sub else ''
assert sub and sub.get('events') == ['AskPermission', 'FinalAnswer']
assert '제목 `Final Answer`' not in prompt
assert 'Session Idle' in prompt
print('ok: omx-bridge subscription prompt is current')
PY
```

## Notification smoke test

1. Create a new visible session from Hermes or a local shell.

```bash
omx-new . --name omx-smoke --attach
```

2. In another shell, check dry-run command dispatch.

```bash
omx-send --list
omx-send --session <bridge-session-id-or-tmux-id> --dry-run 'bridge binding smoke check'
```

3. If real delivery is needed, send without dry-run.

```bash
omx-send --session <bridge-session-id-or-tmux-id> 'Briefly answer only the current cwd and whether you can work.'
```

Expected results:

- A `User Command` notification appears in the project channel or session thread.
- The completion notification uses the user-facing title `Session Idle`, even if the internal payload is `event_type=FinalAnswer`.
- Standalone `SessionIdle` skeleton notifications do not appear separately.
