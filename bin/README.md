# hermes-codex-notify/bin — bridge lifecycle helpers

이 디렉터리는 Hermes가 local `hermes-codex-notify` notification bridge API와 visible tmux 세션을 다루는 최소 helper CLI만 담습니다.

설치되는 명령:

```text
codex-new   # tmux 기반 새 Codex 세션 시작
codex-send  # bridge API로 기존 세션에 지시 전달
codex-kill  # bridge/tmux 세션 종료
```

Bridge가 내부적으로 사용하는 Codex hook entrypoint:

```text
bridge-codex-hook  # SessionStart/UserPromptSubmit/Stop/notify payload를 bridge state로 기록
```

설치:

```bash
bin/install.sh --force
# 또는
scripts/install-codex-cli.sh --force
```

`codex-new`는 `tmux new-session`으로 visible 세션을 만들고 그 안에서 순정 `codex --dangerously-bypass-approvals-and-sandbox`를 실행합니다. `CODEX_EFFORT=high|xhigh|medium`을 설정하면 Codex reasoning effort를 전달합니다.
`codex-send`는 bridge HTTP API를 호출하며, 실제 production command dispatch는 `tmux send-keys` 경로입니다. `mode: codex`는 지원하지 않습니다.

`scripts/install-hermes-stack.sh`와 `scripts/install-systemd-service.sh`는 `bridge-codex-hook`을 Codex hook layer로 기본 등록합니다. `bin/install.sh`는 helper CLI만 설치하므로 hook layer까지 필요한 runtime 설치에는 stack/service installer를 사용하세요.

이 core worktree에는 bridge lifecycle 외 확장 helper가 없습니다. 해당 확장 도구는 `feat/agent-extension` branch에 보존됩니다.
