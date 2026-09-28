# jev-route

**One API for agent harnesses — and Jev decides which one runs.**

jev-route runs Claude Code, Codex, OpenCode and Hermes Agent as your product's backend, each
session in its own hardened container, behind a HarnessRouter-compatible Responses API. Send
`harness_id: "auto"` and TypeSafe's [Jev](https://typesafe.ai) System One model reads the task
and picks the **harness × model × reasoning effort** that fits your objective and budget — in
one ~50–500 ms call that costs a fraction of a cent. Every run's cost and outcome feeds back into
routing.

```bash
curl -N http://127.0.0.1:8420/v1/responses \
  -H "Authorization: Bearer $JEV_ROUTE_KEY" -H "Content-Type: application/json" \
  -d '{"input": "Find why the login test fails after the express v5 upgrade and fix it",
       "metadata": {"harness_id": "auto"},
       "routing": {"objective": "balanced", "max_cost_usd": 2},
       "stream": true}'
```

## Why

Harness APIs such as [HarnessRouter](https://harnessrouter.ai) and AgentSky make you pick the
harness and model by hand. HarnessRouter's own benchmark shows a **~475× cost spread** across
harness/model configurations on the same task, and changing only the harness moves cost 1.5–2×.
Picking right per task is the product; nobody automates it.

| | jev-route | HarnessRouter CE | HarnessRouter Cloud | AgentSky | Harness Router (Protocol-Lattice) |
|---|---|---|---|---|---|
| One API over many harnesses | ✅ 4 + mock | ✅ 9+ | ✅ 15 | ✅ 8 | ❌ (tool routing inside Codex) |
| **Automatic harness × model × effort routing** | ✅ Jev + fallback | ❌ | ❌ | ❌ | tool choice only |
| Per-request reasoning effort | ✅ | ❌ (process-wide) | — | — | — |
| Cost estimate + budget before running | ✅ `max_cost_usd` | ❌ | cost caps | — | — |
| Learns from outcomes & feedback | ✅ | ❌ | — | — | ❌ |
| Per-session container isolation (self-host) | ✅ caps dropped, non-root, no-new-privs | ❌ OS users in one container | ✅ VM per task | ✅ | — |
| UHP 2026-09-12 core conformance | ✅ 40/40 | ✅ | ✅ | own API | — |
| License | Apache-2.0 | Apache-2.0 | proprietary | proprietary | MIT |

"—" = not documented publicly as of 2026-09-28.

## Quickstart

**Docker (recommended — real isolation):**

```bash
cp .env.example .env          # add TYPESAFE_API_KEY and the provider keys you have
docker compose up --build     # builds the agent runtime image and the gateway
open http://127.0.0.1:8420/dashboard
```

**Local dev (no containers; harnesses run as host processes and reuse your CLI logins):**

```bash
corepack enable && pnpm install
JEV_ROUTE_EXECUTOR=local TYPESAFE_API_KEY=… pnpm start
```

Add `JEV_ROUTE_ENABLE_MOCK=1` to get a deterministic `mock` harness for demos and tests without
any provider keys.

## API

Wire-compatible with HarnessRouter / the [Unified Harness Protocol](https://unifiedharnessprotocol.org)
`2026-09-12` core class. Existing clients switch by changing the base URL; they gain
`harness_id: "auto"`.

| Endpoint | |
|---|---|
| `POST /v1/responses` | Run a task. `metadata.harness_id`: `auto` (default) \| `claude-code` \| `codex` \| `opencode` \| `hermes` (or `chrn_<id>`). `stream`, `background`, `previous_response_id`, `reasoning.effort`, `routing.{objective,max_cost_usd}`, `max_step`, `timeout_seconds`, `Idempotency-Key` header. Also served at `/api/harness/v1/responses` and `/{harness_id}/v1/responses`. |
| `POST /v1/route` | Dry-run: returns the routing decision without running anything. |
| `GET /v1/responses/:id` | Read a response (`?stream=true` to attach to a live stream). |
| `POST /v1/responses/:id/cancel` | Cancel; ends `cancelled`, idempotent. |
| `POST /v1/responses/:id/feedback` | `{score: 0..1}` — teaches the router what worked. |
| `GET /v1/responses` · `GET /v1/stats` | Recent runs; spend, success, routing mix, savings. |
| `GET /v1/harnesses` · `GET /v1/models` · `GET /v1/uhp` | Discovery (UHP shapes). |

Every response carries its routing decision in `metadata.route`: the features Jev extracted,
the chosen option and effort, the estimated cost, the no-router baseline, the top candidates with
their score breakdown, and a one-line reason. Streams follow the Responses event sequence with
gapless `sequence_number`s and exactly one terminal event.

### Sessions: one task, many models

Continuing with `previous_response_id` re-routes every turn of an `auto` session: Jev sees a
digest of the earlier turns plus the new request, so "now add tests for it" is judged in context,
and a small continuity bonus avoids switching agents without reason. Correlated turns can land
on different harnesses because memory lives in the workspace, not in any one agent:

- **The workspace is a git repo.** Every turn is a commit authored as `<harness>/<model>`, so
  `git log` / `git show` tell any agent exactly who changed what.
- **`.jev/MEMORY.md`** holds one entry per turn — request, agent/model/effort, a short result
  and the files changed; `.jev/turns/NNNN.md` keeps each turn in full.
- **Same harness as the last turn →** it resumes its own native session (Claude Code
  `--resume`, Codex `exec resume`, OpenCode `--session`). **Different harness, or one that can't
  resume (Hermes) →** it starts fresh with a briefing built from the ledger.
- **`.jev/SKILL.md`** teaches every agent the workflow and is linked from the files each harness
  reads natively (`AGENTS.md` for Codex/OpenCode/Hermes, `CLAUDE.md` for Claude Code) through a
  marked block that leaves project instructions intact: read the ledger when picking up work,
  never rewrite history or edit `.jev/`, and open the final message with a one-line summary —
  which becomes the ledger entry.

Each response reports its commit, turn number and files in `metadata.checkpoint`, and whether it
was a handoff in `metadata.route.handoff`. Sessions pinned to a harness keep it (UHP
`harness_mismatch` otherwise). Tested live: Claude Code wrote a function; Codex, with none of that
conversation, added its inverse and named the original author and commit from the ledger.

## How routing works

1. **Eligibility (code).** Options whose harness isn't installed, whose credentials are missing,
   or that the caller excluded by pinning a harness/model.
2. **Jev, one batched call** with a hard deadline (default 900 ms): `task_type` (choice),
   `difficulty` (5-level score), `edits_code` / `long_horizon` / `needs_web` (noul), and
   `best_option` (choice over the eligible options, described by capability — never price,
   because Jev is poor at arithmetic). Answers are cached by prompt + pool.
3. **Scoring (code).** `score = tier fit + task affinity + Jev preference + outcome prior − λ(objective) · log-normalised est. cost`.
   Under-provisioning (a hard task on a weak tier) is penalised far more than over-provisioning.
   The prior comes from logged outcomes per task type and option — explicit feedback when
   given, otherwise completed/failed — shrunk towards a neutral mean so it only matters once
   there's data. Observed actual/estimated cost ratios recalibrate the estimates.
4. **Effort** follows difficulty and objective and is mapped to each harness's native knob
   (`claude --effort`, Codex `model_reasoning_effort`).
5. **Budget.** Options estimated above `max_cost_usd` are dropped; if none remain, the request
   fails fast with `jevroute.budget_exceeded` and the cheapest estimate.
6. **Fallback.** No key, timeout, 429/529 or a malformed answer → keyword heuristics produce the
   same features, and the decision records `source: "heuristic"` with the reason.

### Routing eval

`pnpm eval:router` runs the router over 40 labelled tasks (`packages/router/eval/dataset.jsonl`)
and reports task-type accuracy, difficulty error, under/over-provisioning and estimated spend.
With `TYPESAFE_API_KEY` set it evaluates Jev; without it, the keyword fallback. Measured
2026-09-28 with `jev-latest`:

| engine, objective | tier exact | under-provisioned | over-provisioned | est. saving vs top tier | router p50 / p95 |
|---|---|---|---|---|---|
| **Jev, balanced** | **90–95%** | **2.5–5%** | 2.5–5% | 41% | 336 / 420 ms |
| Jev, best | 95% | 0% | 5% | 41% | 359 / 448 ms |
| Jev, cheapest | 72.5% | 27.5% (by design) | 0% | 58% | 349 / 398 ms |
| fallback, balanced | 80% | 7.5% | 12.5% | 37% | <1 ms |

Jev answers vary slightly between runs (the balanced range is two runs); `jev-preview` scored
no better. The fallback rules and the labels were written together, so treat the fallback row
as an upper bound. Add your own tasks to the dataset.

## Isolation and security

- One container per session from `jev-route/agent-runtime`: non-root user, `--cap-drop ALL`,
  `no-new-privileges`, pid/cpu/memory limits, configurable network
  (`JEV_ROUTE_CONTAINER_NETWORK=none` for offline work). The session's home lives on a named
  volume so idle containers are reaped (`JEV_ROUTE_CONTAINER_IDLE_MS`) without losing work;
  sessions expire after `JEV_ROUTE_SESSION_RETENTION_MS`.
- Provider keys are sent per run over stdin — never container env or args, so they don't show
  in `docker inspect` — and each harness gets only its own provider's keys.
- Key values are redacted from every streamed event and stored output.
- Harnesses run with their permission prompts bypassed *because* the container is the sandbox.
  The `local` executor has no isolation and is for development only.
- API auth: bearer tokens from `JEV_ROUTE_API_KEYS`, compared in constant time.

## Using subscriptions instead of API keys

- **Claude Code:** `claude setup-token`, then set `CLAUDE_CODE_OAUTH_TOKEN`.
- **Codex (ChatGPT plan):** create a dedicated login and point the gateway at it —
  `CODEX_HOME=~/.codex-jev-route codex login`, then `CODEX_AUTH_FILE=~/.codex-jev-route/auth.json`
  (with compose, mount the folder into the gateway and set `CODEX_AUTH_FILE=/run/codex/auth.json`).
  The file travels to sandboxes over stdin like any key, and its tokens are redacted from output.
  A ChatGPT login serves `gpt-5.6-luna`, `gpt-5.6-terra` and `gpt-6-astra`; the router only
  offers Codex models the configured credential can run. Subscription use is subject to your
  plan's limits; for production traffic use API keys.

## Configuration

See [`.env.example`](.env.example). The catalog of options and prices lives in
[`packages/core/src/catalog.ts`](packages/core/src/catalog.ts) (prices as published
2026-09-28); override it with `JEV_ROUTE_CATALOG=catalog.json`
(`{"options": [...], "harnesses": {...}}`). Point `TYPESAFE_BASE_URL` at any wire-compatible
System One server (e.g. a self-hosted OpenJev) to avoid a hard dependency on TypeSafe.

## Architecture

```
packages/core      shared types, catalog + cost model, redaction
packages/router    Jev client, question set, scorer, heuristic fallback, cache, eval
packages/agentd    in-sandbox runner: harness drivers → normalized NDJSON events
apps/gateway       Hono API, SSE, sessions, SQLite store, executors (docker | local), dashboard
docker/            agent-runtime image (all harness CLIs + agentd), gateway image
```

```
client ─▶ gateway ─ auth · idempotency ─▶ router (Jev ⟶ scorer | heuristic) ─▶ budget
                 └─▶ executor ─ docker exec ─▶ agentd ─▶ claude | codex | opencode | hermes
                 ◀─ Responses SSE ◀─ normalizer ◀─ NDJSON events
                 └─▶ SQLite: responses · sessions · route decisions · outcomes · feedback
```

## Development

```bash
pnpm test                 # unit + integration (no keys or Docker needed)
pnpm typecheck
pnpm eval:router
pnpm build:image && JEV_ROUTE_DOCKER_E2E=1 pnpm test apps/gateway/test/docker.e2e.test.ts
```

UHP conformance, using HarnessRouter's suite:

```bash
pip install -e <harnessrouter>/protocol/conformance
uhp-conformance --base-url http://127.0.0.1:8420 --api-key $KEY --class core --harness-id chrn_auto
```

## Status and roadmap

MVP. Verified end to end with live Jev routing and real Claude Code and Codex runs
(streaming, tool calls, native resume, cost). OpenCode and Hermes are installed in the image and their drivers are tested
against their documented output formats, but haven't had a live run yet.

Next: file inputs/outputs (UHP extended class), a cloud sandbox executor (E2B / Vercel
Sandbox), OpenCode effort via `--variant`, per-org budgets, and training the router's priors
into a small learned ranker as outcome data accumulates
([Agentic Routing](https://arxiv.org/abs/2607.11399)).

## License

Apache-2.0
