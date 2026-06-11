---
name: tm-kill
description: Stop/kill/close an existing verified managed tmux session selected by bridge session id, project, or tmux id using the local tm-kill helper. Direct tmux targets are GJC-managed only. Trigger on 종료, kill, 킬, 죽여, stop, close, clean up a managed session. Do not handle new-session creation or prompt delivery.
version: 0.1.0
prerequisites:
  commands: [tm-kill, tmux, curl, jq]
metadata:
  hermes:
    tags: [omx, bridge, tmux, stop, cleanup]
    related_skills: [hermes-tmux-bridge, tm-new, tm-send]
    requires_toolsets: [terminal]
    triggers:
      - 종료, 이 세션 종료해, 세션 kill, kill, 킬, 세션 죽여, 죽여, stop/close/clean up session -> tm-kill
      - 새 세션, 세션 열어, 시작해 -> use tm-new instead
      - 전달, 보내, 넘겨, follow-up, 반영, 수정, 계속 -> use tm-send instead
---

# TM Kill

Use this skill for existing-session termination. Use `tm-kill` to terminate a verified managed tmux session associated with a bridge session. Direct `--tmux` targets are limited to GJC-managed ownership tags. This replaces legacy `cwt-kill`.

## Boundary

- Owns: stopping/killing/closing an existing verified managed tmux session. Direct target validation is GJC-managed only.
- Does not own: creating sessions (`tm-new`), sending prompts/approvals (`tm-send`), or bridge read/status inspection (`hermes-tmux-bridge`).
- In Discord notification replies, the target is the replied alert metadata (`bridge_session_id`, `session:`, or exact `tmux:`), not the latest same-project session.


## Backend boundary

- Prefer `--session <bridgeSessionId>` over broad project matching.
- Direct `--tmux-id` cleanup is only safe for an exact GJC-managed target with ownership tags; use `--dry` first when the target was not resolved from reply metadata.
- If an OMX session cannot be verified through the supported bridge stop path, fail closed and report unsupported rather than raw-killing an arbitrary tmux session.
- Do not add a separate `gjc-kill`; explicit GJC sessions still use `tm-kill`.

## Safety

- Prefer `--session <bridgeSessionId>` over broad project matching.
- Use `--dry` first when the target is ambiguous.
- In non-interactive Hermes runs, pass `--force` only after the user asked to stop that session.

## Commands

```bash
tm-kill --session <bridgeSessionId> --dry
tm-kill --session <bridgeSessionId> --force
tm-kill --project <project> --force
tm-kill --tmux-id <tmuxSession> --force
```

Report which verified managed tmux session was killed and whether bridge still lists any active sessions for the project.
