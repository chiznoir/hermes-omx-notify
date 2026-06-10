---
name: tm-new
description: Start/create/launch a new visible GJC tmux session for a repository/project through the local tm-new helper. Trigger on 새 세션, 세션 열어, 시작해, create/launch/start/watch a new GJC session. Do not handle existing-session prompt delivery or session termination.
version: 0.1.0
prerequisites:
  commands: [tm-new, tmux, gjc]
metadata:
  hermes:
    tags: [omx, bridge, tmux, codex, session]
    related_skills: [hermes-omx-notify, tm-send, tm-kill]
    requires_toolsets: [terminal]
    triggers:
      - 새 세션, 세션 열어, 시작해, create/launch/start/watch a new GJC session -> tm-new
      - 전달, 보내, 넘겨, follow-up, 반영, 수정, 계속 -> use tm-send instead
      - 종료, kill, 킬, 죽여, stop/close session -> use tm-kill instead
---

# TM New

Use this skill for new session creation. Use `tm-new` to start a new visible GJC tmux session. This replaces legacy `cwt-new` and does not use clawhip.
Hermes should use `tm-new` rather than raw `gjc`; the helper applies managed tmux ownership tags and session registration defaults.

## Boundary

- Owns: creating/launching a new visible GJC tmux session.
- Does not own: sending prompts to an existing session (`tm-send`), killing sessions (`tm-kill`), or bridge read/status inspection (`hermes-omx-notify`).
- Bridge webhook `SessionStart` alert bodies are notifications, not requests to create another session.
- `/new` or `/resume` inside an existing Codex pane prompt is a Codex slash command and should be delivered by `tm-send`, not handled here.

## Policy

- Default launch: `tmux new-session ... 'gjc'` via the `tm-new` script, followed by `@gjc-*` ownership-tag verification.
- Do not add `--tmux` inside the native tmux session.
- Do not add `--direct` unless the user explicitly wants to bypass managed tmux launch and run `gjc` in the current terminal.
- Do not add `--disable codex_hooks` as a default; remove clawhip hooks instead of disabling all Codex hooks.
- In chat/gateway contexts, do **not** treat Hermes' own current working directory as the target project just because the user says “새 세션 열어줘”. Resolve the intended project from the user's wording, replied-to context, active bridge sessions, or known workspace paths first. If no project is inferable, ask for the target instead of opening in `~/.hermes/hermes-agent`.

## Commands

Before launching, identify the repository path explicitly. Prefer stable workspace locations such as `~/work/<project>` when the user names a project, and verify the directory exists.

```bash
# Resolve named project before launching; do not default to Hermes cwd for ambiguous requests.
for d in "$HOME/work/<project>" "$HOME/docs/<project>" "$HOME/.hermes/<project>"; do [ -d "$d" ] && printf '%s\n' "$d"; done

tm-new [PROJECT_DIR] [--name SESSION] [--attach] [--direct] [--json] [--no-check] [-- GJC_ARGS...]
tm-new /path/to/repo --json
tm-new /path/to/repo --name gjc-project-main
```

After launch, use `hermes-omx-notify` or:

```bash
tm-send --project <project> "현재 상태를 요약해줘"
```

If the visible pane is blocked by a trust/setup prompt, clear it before sending work. Be conservative with update prompts: default to `n` unless the user explicitly tells you to update, because accepting an OMX update can enter setup prompts and mutate global/user Codex config before the requested session starts.

```bash
# decline/update prompt if present unless the user explicitly requested update
 tmux capture-pane -t <tmuxId> -p -S -80 | tail -80
 tmux send-keys -t <tmuxId> 'n' Enter   # for "Update now? [Y/n]" by default
 tmux send-keys -t <tmuxId> Enter       # only for "Do you trust this directory?" when the directory is the requested project
```

If the user explicitly asks to accept the update:

```bash
 tmux send-keys -t <tmuxId> 'y' Enter
 # If setup asks for preferences and user wants legacy/keep, send 1.
 tmux send-keys -t <tmuxId> '1' Enter
```

If setup/update prompts cause sessions to exit immediately, do not keep reopening sessions blindly. Report the exact `gjc` startup failure, confirm whether tmux stayed alive, and fix the underlying GJC/Codex config issue before retrying. Do not silently fall back to OMX launch semantics on this branch.

After any update/setup prompt, verify the session did not exit before reporting success:

```bash
 tmux has-session -t <tmuxId>
 tmux capture-pane -t <tmuxId> -p -S -120 | tail -80
 tm-send --list | head
```

Known post-update failure: `Error loading config.toml ... duplicate key` in `~/.codex/config.toml` means the session did not start; see `references/omx-update-config-duplicate-key.md` before retrying.

Report the tmux session id, project path, and bridge `/sessions` check result if available, but only call the session "started" after tmux is still alive and the bridge shows it active/known.
