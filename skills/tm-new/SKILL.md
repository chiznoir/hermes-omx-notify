---
name: tm-new
description: Start/create/launch a new visible OMX tmux session by default, or an explicit GJC tmux session with --gjc, through the local tm-new helper. Trigger on 새 세션, 세션 열어, 시작해, create/launch/start/watch a new OMX session. Do not handle existing-session prompt delivery or session termination.
version: 0.2.0
prerequisites:
  commands: [tm-new, tmux, omx, gjc]
metadata:
  hermes:
    tags: [omx, bridge, tmux, codex, session]
    related_skills: [hermes-tmux-bridge, tm-send, tm-kill]
    requires_toolsets: [terminal]
    triggers:
      - 새 세션, 세션 열어, 시작해, create/launch/start/watch a new OMX session -> tm-new
      - GJC 새 세션, GJC로 열어, gjc --tmux로 시작 -> tm-new --gjc
      - 전달, 보내, 넘겨, follow-up, 반영, 수정, 계속 -> use tm-send instead
      - 종료, kill, 킬, 죽여, stop/close session -> use tm-kill instead
---

# TM New

Use this skill for new session creation. Use `tm-new` to start a new visible OMX/Codex tmux session by default. Use `tm-new --gjc` only when the user explicitly asks for GJC. This replaces legacy `cwt-new`; do not introduce `gjc-new`, `omx-new`, or shim aliases.

Hermes should use `tm-new` for bridge-managed launches. For explicit GJC launches, use `tm-new --gjc` rather than launching `gjc --tmux` directly from Hermes so the helper keeps the bridge contract and output shape consistent.

## Boundary

- Owns: creating/launching a new visible OMX tmux session by default, or an explicit GJC session with `--gjc`.
- Does not own: sending prompts to an existing session (`tm-send`), killing sessions (`tm-kill`), or bridge read/status inspection (`hermes-tmux-bridge`).
- Bridge webhook `SessionStart` alert bodies are notifications, not requests to create another session.
- `/new` or `/resume` inside an existing Codex pane prompt is a Codex slash command and should be delivered by `tm-send`, not handled here.

## Policy

- Default launch: `tm-new [PROJECT_DIR]` starts an OMX session with `omx --madmax --high` in a visible tmux pane.
- Attach shorthand: `tm-new a ...` attaches after creation. `a` is reserved before `--`; use `./a` for a directory literally named `a`.
- Explicit GJC launch: `tm-new --gjc [PROJECT_DIR]` runs GJC's native `gjc --tmux` path. `tm-new --gjc --worktree PATH` runs `gjc --tmux --worktree PATH`.
- Do not create a separate `gjc-new` helper, and do not keep `omx-new -a` or other legacy aliases in user-facing guidance.
- `--direct` is OMX-only. Do not combine it with `--gjc`; GJC must use `gjc --tmux` so bridge-managed tags can be verified.
- `--runs` / `--runs-dir` is OMX-only. `--worktree` is GJC-only.
- Do not add `--disable codex_hooks` as a default; remove bad hooks instead of disabling all Codex hooks.
- In chat/gateway contexts, do **not** treat Hermes' own current working directory as the target project just because the user says “새 세션 열어줘”. Resolve the intended project from the user's wording, replied-to context, active bridge sessions, or known workspace paths first. If no project is inferable, ask for the target instead of opening in `~/.hermes/hermes-agent`.

## Commands

Before launching, identify the repository path explicitly. Prefer stable workspace locations such as `~/work/<project>` when the user names a project, and verify the directory exists.

```bash
# Resolve named project before launching; do not default to Hermes cwd for ambiguous requests.
for d in "$HOME/work/<project>" "$HOME/docs/<project>" "$HOME/.hermes/<project>"; do [ -d "$d" ] && printf '%s
' "$d"; done

# Default: OMX session.
tm-new [a] [PROJECT_DIR] [--name SESSION] [--attach] [--direct] [--json] [--runs PATH] [--no-check] [-- OMX_ARGS...]
tm-new /path/to/repo --json
tm-new a /path/to/repo --name omx-project-main

# Explicit GJC session.
tm-new [a] --gjc [PROJECT_DIR] [--name SESSION] [--worktree PATH] [--json] [--no-check] [-- GJC_ARGS...]
tm-new --gjc /path/to/repo --json
tm-new a --gjc /path/to/repo --worktree ../task-worktree
```

After launch, use `hermes-tmux-bridge` or:

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

If setup/update prompts cause sessions to exit immediately, do not keep reopening sessions blindly. Report the exact startup failure, confirm whether tmux stayed alive, and fix the underlying OMX/Codex or GJC/Codex config issue before retrying. Do not silently switch backends.

After any update/setup prompt, verify the session did not exit before reporting success:

```bash
 tmux has-session -t <tmuxId>
 tmux capture-pane -t <tmuxId> -p -S -120 | tail -80
 tm-send --list | head
```

Known post-update failure: `Error loading config.toml ... duplicate key` in `~/.codex/config.toml` means the session did not start; see `references/omx-update-config-duplicate-key.md` before retrying.

Report the tmux session id, backend, project path, and bridge `/sessions` check result if available, but only call the session "started" after tmux is still alive and the bridge shows it active/known.
