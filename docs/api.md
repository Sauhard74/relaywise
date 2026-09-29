# HTTP API

relaywise speaks the Responses-style API used by [HarnessRouter](https://harnessrouter.ai) and the
[Unified Harness Protocol](https://unifiedharnessprotocol.org) (`2026-09-12`, core class — it
passes the conformance suite 40/40). Existing clients switch by changing the base URL, and gain
`harness_id: "auto"`.

```bash
curl -N http://127.0.0.1:8420/v1/responses \
  -H "Authorization: Bearer $RELAYWISE_KEY" -H "Content-Type: application/json" \
  -d '{"input": "Find why the login test fails after the express v5 upgrade and fix it",
       "metadata": {"harness_id": "auto", "project_id": "my-app"},
       "routing": {"objective": "balanced", "max_cost_usd": 2},
       "stream": true}'
```

## Endpoints

| Endpoint | What it does |
|---|---|
| `POST /v1/responses` | Run a task. See the fields below. Also served at `/api/harness/v1/responses` and `/{harness_id}/v1/responses`. |
| `POST /v1/route` | Show the routing decision without running anything. |
| `GET /v1/responses/:id` | Read a response; `?stream=true` attaches to a live stream. |
| `POST /v1/responses/:id/cancel` | Stop a run. It ends `cancelled`; calling it again is harmless. |
| `POST /v1/responses/:id/feedback` | `{"score": 0..1}` — tells the router whether it worked. |
| `GET /v1/responses`, `GET /v1/stats` | Recent runs; spend, success rate, routing mix, savings. |
| `GET /v1/projects/:id`, `/memory`, `DELETE` | A project's stats, its ledger (`?turn=N` for one turn), or delete it. |
| `POST /v1/projects/:id/sync`, `GET /v1/projects/:id/diff` | Used by the CLI to mirror a working tree and fetch a turn's patch. |
| `GET /v1/harnesses`, `GET /v1/models`, `GET /v1/uhp` | Discovery. |

**`POST /v1/responses` fields:** `input` (text or input items), `instructions`, `stream`,
`background`, `previous_response_id` (continue a session), `model`, `reasoning.effort`,
`routing.objective` (`cheapest` | `balanced` | `best`), `routing.max_cost_usd`, `max_step`,
`timeout_seconds`, and in `metadata`: `harness_id` (`auto`, `claude-code`, `codex`, `opencode`,
`hermes`, or `chrn_<id>`) and `project_id`. Send an `Idempotency-Key` header to make retries safe.

Streams follow the Responses event sequence with gapless `sequence_number`s and exactly one
terminal event. Errors use `{"error": {"type", "code", "message", "param"}}`; relaywise-specific
codes are prefixed `relaywise.`.

## Sessions and memory

A session is one task and its follow-ups (`previous_response_id`). Memory lives in the workspace,
not in any one agent, so consecutive turns can run on different agents:

- The workspace is a git repo; every turn is a commit authored as `<agent>/<model>`.
- `.relay/MEMORY.md` records each turn — request, agent, model, effort, a short result and the
  files changed — and `.relay/turns/NNNN.md` keeps each turn in full.
- The same agent as the previous turn resumes its own session (Claude Code `--resume`, Codex
  `exec resume`, OpenCode `--session`). A different agent — or Hermes, which can't resume — starts
  fresh and is briefed from the ledger.
- `.relay/SKILL.md`, linked from `AGENTS.md` and `CLAUDE.md` through a marked block that leaves
  project instructions intact, tells every agent how to work with the ledger.

`auto` sessions are re-routed every turn; sessions pinned to one agent keep it. Each response
reports its commit, turn number and changed files in `metadata.checkpoint`, and whether it was a
handoff in `metadata.route.handoff`.

**Projects** (`metadata.project_id` or an `X-Project-Id` header) make that memory permanent: the
workspace belongs to the project, so a brand-new session starts with everything earlier sessions
did and is briefed from the ledger. One turn runs at a time per project. Project workspaces don't
expire.
