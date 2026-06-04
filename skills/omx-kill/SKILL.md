---
name: tmux-kill
description: Stop/kill/close an existing managed GJC tmux session selected by bridge session id, project, or tmux id using the local tmux-kill helper. Trigger on 종료, kill, 킬, 죽여, stop, close, clean up a managed session. Do not handle new-session creation or prompt delivery.
version: 0.1.0
prerequisites:
  commands: [tmux-kill, tmux, curl, jq]
metadata:
  hermes:
    tags: [omx, bridge, tmux, stop, cleanup]
    related_skills: [hermes-omx-notify, tmux-new, tmux-send]
    requires_toolsets: [terminal]
    triggers:
      - 종료, 이 세션 종료해, 세션 kill, kill, 킬, 세션 죽여, 죽여, stop/close/clean up session -> tmux-kill
      - 새 세션, 세션 열어, 시작해 -> use tmux-new instead
      - 전달, 보내, 넘겨, follow-up, 반영, 수정, 계속 -> use tmux-send instead
---

# Tmux Kill

Use this skill for existing-session termination. Use `tmux-kill` to terminate the managed GJC tmux session associated with a bridge session. This replaces legacy `cwt-kill`.

## Boundary

- Owns: stopping/killing/closing an existing managed GJC tmux session.
- Does not own: creating sessions (`tmux-new`), sending prompts/approvals (`tmux-send`), or bridge read/status inspection (`hermes-omx-notify`).
- In Discord notification replies, the target is the replied alert metadata (`bridge_session_id`, `session:`, or exact `tmux:`), not the latest same-project session.

## Safety

- Prefer `--session <bridgeSessionId>` over broad project matching.
- Use `--dry` first when the target is ambiguous.
- In non-interactive Hermes runs, pass `--force` only after the user asked to stop that session.

## Commands

```bash
tmux-kill --session <bridgeSessionId> --dry
tmux-kill --session <bridgeSessionId> --force
tmux-kill --project <project> --force
tmux-kill --tmux-id <tmuxSession> --force
```

Report which managed tmux session was killed and whether bridge still lists any active sessions for the project.
