# hermes-omx-notify/bin — bridge lifecycle helpers

이 디렉터리는 Hermes가 local `hermes-omx-notify` API와 visible tmux 세션을 다루는 최소 helper CLI만 담습니다.

설치되는 명령:

```text
omx-new   # tmux 기반 새 OMX/Codex 세션 시작
omx-send  # bridge API로 기존 세션에 지시 전달
omx-kill  # bridge/tmux 세션 종료
```

설치:

```bash
bin/install.sh --force
# 또는
scripts/install-omx-cli.sh --force
```

`omx-new`는 `tmux new-session`으로 visible 세션을 만들고 그 안에서 `omx --madmax --high`를 실행합니다.  
`omx-send`는 bridge HTTP API를 호출하며, 실제 production command dispatch는 `tmux send-keys` 경로입니다. `mode: codex`는 지원하지 않습니다.

이 core worktree에는 bridge lifecycle 외 확장 helper가 없습니다. 해당 확장 도구는 `feat/agent-extension` branch에 보존됩니다.
