# `jev` CLI — scope

A terminal agent in the style of Claude Code / Codex CLI, backed by the jev-route gateway: you
work in your own repo, Jev routes each request to the best harness × model × effort, the agent
runs in an isolated sandbox, and its changes land in your working tree as a diff.

## In scope (v1)

**Interactive mode — `jev`** (in any directory)
- Welcome header: directory, project, gateway, routing engine, available harnesses.
- Prompt box with history (↑/↓), Enter to send; `Esc` / `Ctrl+C` cancels a running turn,
  `Ctrl+C` twice (or `Ctrl+D`) exits.
- Each turn shows, live: the routing decision (harness · model · effort · why · est. cost),
  a spinner while the agent thinks, one line per tool call, streamed assistant text, then a
  footer with status, real cost, duration and files changed.
- Conversation continuity: turns in one `jev` run are one session (native resume on the same
  harness, ledger briefing on a switch). `/new` starts a new session in the same project —
  still briefed from the project ledger.

**Your repo is the source of truth**
- Project id derives from the directory (`<name>-<hash of path>`), so memory persists per repo.
- Before each turn: sync the working tree to the project workspace (git-tracked + untracked
  non-ignored files; falls back to a filtered walk outside git). Deletions propagate.
- After each turn: pull that turn's commit as a binary-safe patch and `git apply` it locally.
  Ledger files (`.jev/`) and the managed `AGENTS.md` / `CLAUDE.md` blocks stay remote.
- `/diff` shows the last applied change; `/undo` reverts it locally.

**Slash commands:** `/help`, `/route <prompt>` (dry-run), `/harness <auto|claude-code|codex|
opencode|hermes>`, `/model <id|auto>`, `/effort <low…max|auto>`, `/objective
<cheapest|balanced|best>`, `/budget <usd|off>`, `/memory [turn]`, `/diff`, `/undo`, `/new`,
`/cost`, `/status`, `/exit`.

**Non-interactive:** `jev -p "prompt"` streams to stdout and exits non-zero on failure;
`--json` prints the final response object. Same flags as settings: `--harness`, `--model`,
`--effort`, `--objective`, `--budget`, `--project`, `--no-sync`.

**Config:** `JEV_ROUTE_URL` (default `http://127.0.0.1:8420`), `JEV_ROUTE_KEY`, or
`--url` / `--key`.

## Gateway additions

- `POST /v1/projects/:id/sync` — tar of the local tree; extracted into the workspace, files
  missing from the upload are deleted (ledger and managed files excepted), committed as
  `jev-route: sync from local` so turn diffs contain only agent changes.
- `GET /v1/projects/:id/diff?commit=<sha>` — `git show --binary` of a turn, excluding ledger
  and managed files.

## Out of scope (v1)

Approval prompts per tool call (agents run unattended in the sandbox; you review the diff),
image input, a local (non-sandboxed) mode, Windows-specific handling, multi-repo projects,
conflict resolution beyond `git apply --3way`.
