# hermes-tmux-bridge/bin — bridge lifecycle helpers

이 디렉터리는 Hermes가 local `hermes-tmux-bridge` API와 visible tmux 세션을 다루는 최소 helper CLI만 담습니다.

설치되는 canonical 명령:

```text
tmux-new   # managed GJC tmux 세션 시작
tmux-send  # bridge API 또는 managed tmux target으로 기존 세션에 지시 전달
tmux-kill  # managed bridge/tmux 세션 종료
```

설치:

```bash
bin/install.sh --force
# 또는
scripts/install-omx-cli.sh --force
```

`tmux-new`는 `tmux new-session`으로 visible 세션을 만들고 그 안에서 `gjc`를 실행한 뒤 `@gjc-*` ownership tag를 검증합니다.  
`tmux-send`는 bridge HTTP API를 호출하거나 managed tmux target에만 직접 전달합니다. `mode: codex`는 지원하지 않습니다.

이 core worktree에는 bridge lifecycle 외 확장 helper가 없습니다. 해당 확장 도구는 `feat/agent-extension` branch에 보존됩니다.
