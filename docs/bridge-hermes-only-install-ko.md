# Bridge + Hermes only install — agent runbook

[English](bridge-hermes-only-install.md) | **한국어**

이 문서는 새 PC나 새 Hermes Agent에 **hermes-tmux-bridge와 Hermes/Discord 알림 연동만** 설치할 때 사용합니다. AgentMemory, CodeGraph, Cognee, Codex MCP memory/search 도구는 설치하지 않습니다.

## 목표

설치 후 아래만 동작하면 완료입니다.

1. `hermes-tmux-bridge` server가 `127.0.0.1:3037`에서 systemd user service로 실행된다.
2. Hermes에 `hermes-tmux-bridge`, `tm-new`, `tm-send`, `tm-kill` skill이 설치된다.
3. Hermes Gateway webhook subscription `tmux-bridge`가 `AskPermission,FinalAnswer` 이벤트를 받는다.
4. Discord project channel 또는 session thread로 알림이 전달된다.
5. `tm-new`, `tm-send`, `tm-kill` helper CLI가 `PATH`에 있다.

필요한 helper CLI는 `scripts/install-hermes-stack.sh`가 `tm-new`, `tm-send`, `tm-kill`만 설치합니다. CLI만 설치할 때는 `bin/install.sh --force` 또는 `scripts/install-omx-cli.sh --force`를 사용합니다.

## 설치하지 않는 것

아래 도구는 이 runbook의 대상이 아닙니다.

- `omx-bootstrap`, `omx-status`, `omx-sync`, `omx-cleanup`
- AgentMemory / CodeGraph / RTK / Cognee / CLIProxy / caveman helper 설치
- Codex global hook 또는 MCP 설정 변경

## agent가 operator에게 받아야 하는 값

비밀값은 화면에 다시 출력하지 말고, 파일 경로나 설정 여부만 보고합니다.

필수:

- Discord fallback channel ID: 알림을 보낼 기본 채널 ID
- Discord bot token: Hermes Gateway/bridge가 Discord에 메시지를 보내는 bot token
- Discord guild/server ID: Discord 서버 ID
- Hermes Gateway `WEBHOOK_SECRET` 설정 위치 또는 설정 권한

권장:

- project별 Discord channel mapping: 예) `hermes-tmux-bridge=345678901234567890`
- SessionStart mention 대상 Discord user ID: 예) `456789012345678901`

선택:

- bridge bearer token: bridge를 Docker/LAN/reverse proxy/public에 노출할 때만 필요
- 기존 Hermes home 경로: 기본값은 `~/.hermes`

## 사전 조건 확인

```bash
node --version   # >= 20
npm --version
curl --version
jq --version
tmux -V
systemctl --user status hermes-gateway.service --no-pager || true
curl -sS http://127.0.0.1:8644/health || true
```

Hermes Gateway webhook platform은 켜져 있어야 합니다. Gateway env에 아래 값이 있어야 하고,
`WEBHOOK_SECRET`은 bridge installer가 쓰는 secret file 값과 같아야 합니다.

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=<bridge secret file 값과 동일>
```

Gateway env 위치가 환경마다 다르므로 agent는 위치를 추정하지 말고 operator에게 확인합니다.

## clone과 검증

```bash
git clone https://github.com/chiznoir/hermes-tmux-bridge.git
cd hermes-tmux-bridge
npm install
npm test
```

## 권장 설치: Hermes webhook 알림 포함

아래 명령은 bridge service, Hermes skills, webhook subscription, helper CLI를 한 번에 설치합니다.

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

`--project`는 여러 번 줄 수 있습니다.

```bash
scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --restart \
  --direct \
  --threads \
  --channel <fallback-discord-channel-id> \
  --project hermes-tmux-bridge=<project-channel-id> \
  --project other-project=<other-project-channel-id> \
  --bot-token '<discord-bot-token>' \
  --guild <discord-guild-or-server-id> \
  --mention-users <discord-user-id>
```

같은 host의 `127.0.0.1` 전용이면 bridge bearer token은 비워둘 수 있습니다.
Docker/LAN/reverse proxy/public으로 노출하면 token file을 만들고 `--token-file`을 추가합니다.

```bash
mkdir -p ~/.config/hermes-tmux-bridge
openssl rand -hex 32 > ~/.config/hermes-tmux-bridge/bridge.token
chmod 600 ~/.config/hermes-tmux-bridge/bridge.token

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
  --token-file ~/.config/hermes-tmux-bridge/bridge.token
```

## 정말 “Hermes가 직접 조회만” 하는 bridge-only 모드

자동 Discord push 알림이 필요 없고 Hermes가 bridge API만 조회하면 되는 환경에서는 `--webhook` 없이 설치합니다.
이 모드는 Hermes Gateway webhook subscription을 만들지 않습니다.

```bash
scripts/install-hermes-stack.sh --non-interactive --restart
```

단, 이 경우 `FinalAnswer` / `AskPermission` 자동 알림은 오지 않습니다.

## 설치 산출물

```text
~/.local/bin/tm-new
~/.local/bin/tm-send
~/.local/bin/tm-kill
~/.hermes/skills/autonomous-ai-agents/hermes-tmux-bridge/SKILL.md
~/.hermes/skills/autonomous-ai-agents/tm-new/SKILL.md
~/.hermes/skills/autonomous-ai-agents/tm-send/SKILL.md
~/.hermes/skills/autonomous-ai-agents/tm-kill/SKILL.md
~/.config/systemd/user/hermes-tmux-bridge.service
~/.config/hermes-tmux-bridge/hermes-tmux-bridge.env
~/.config/hermes-tmux-bridge/hermes-webhook.secret
~/.config/hermes-tmux-bridge/project-channels.json
~/.hermes/webhook_subscriptions.json
```

## 검증

```bash
systemctl --user is-active hermes-tmux-bridge.service
systemctl --user status hermes-tmux-bridge.service --no-pager
curl -fsS http://127.0.0.1:3037/health | jq .

systemctl --user is-active hermes-gateway.service
curl -fsS http://127.0.0.1:8644/health | jq .

command -v tm-new tm-send tm-kill
hermes skills list | grep 'hermes-tmux-bridge'
```

Webhook subscription prompt가 오래된 규칙을 갖지 않는지도 확인합니다.
`FinalAnswer`는 내부 event type으로 유지하지만, 사용자 제목은 `Session Idle`이어야 합니다.

```bash
python - <<'PY'
import json, os
p = os.path.expanduser('~/.hermes/webhook_subscriptions.json')
data = json.load(open(p))
sub = data.get('tmux-bridge') or data.get('subscriptions', {}).get('tmux-bridge')
prompt = sub.get('prompt', '') if sub else ''
assert sub and sub.get('events') == ['AskPermission', 'FinalAnswer']
assert '제목 `Final Answer`' not in prompt
assert 'Session Idle' in prompt
print('ok: tmux-bridge subscription prompt is current')
PY
```

## 알림 smoke test

1. Hermes 또는 local shell에서 새 visible session을 만듭니다.

```bash
tm-new . --name omx-smoke --attach
```

2. 다른 shell에서 dry-run command dispatch를 확인합니다.

```bash
tm-send --list
tm-send --session <bridge-session-id-or-tmux-id> --dry-run 'bridge binding smoke check'
```

3. 실제 전달이 필요하면 dry-run 없이 보냅니다.

```bash
tm-send --session <bridge-session-id-or-tmux-id> '짧게 현재 cwd와 작업 가능 여부만 답해줘.'
```

기대값:

- `User Command` 알림이 project channel/session thread에 온다.
- 답변 완료 알림은 내부 payload `event_type=FinalAnswer`라도 사용자 제목은 `Session Idle`로 온다.
- standalone `SessionIdle` 골격 알림은 별도로 오지 않는다.

## 실패 시 확인 순서

```bash
systemctl --user status hermes-tmux-bridge.service --no-pager
journalctl --user -u hermes-tmux-bridge.service -n 100 --no-pager
systemctl --user status hermes-gateway.service --no-pager
journalctl --user -u hermes-gateway.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3037/sessions | jq '.sessions | length'
```

원칙:

- `~/.config/hermes-tmux-bridge/hermes-tmux-bridge.env`에는 켠 기능, secret/token 경로 또는 값, non-default override만 둡니다.
- secret/token 원문은 최종 보고에 쓰지 않습니다.
- AgentMemory, CodeGraph, RTK 같은 extension 도구 문제는 이 runbook의 blocker로 취급하지 않습니다.
