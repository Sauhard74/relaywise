# relaywise — design

**One API for agent harnesses, with Jev picking the right one.**
Drop-in compatible with HarnessRouter's Responses-style API (`POST /v1/responses`,
`metadata.harness_id`), plus `harness_id: "auto"`: TypeSafe's Jev routes every task to
the best **harness × model × effort** for the caller's objective and budget.

## Why

HarnessRouter / AgentSky make you pick the harness and model by hand, yet HarnessRouter's
own benchmark shows a ~475× cost spread across configurations on one task. Jev answers typed
questions in ~50–500 ms for $0.042/MTok, so routing costs ~nothing relative to the run.

## Architecture

```
client ─HTTP/SSE─▶ gateway (Hono, Node)
                     1 auth + Idempotency-Key
                     2 router: Jev (deadline) → scorer (code) ; heuristic fallback
                     3 budget guard (estimated cost ≤ max_cost_usd)
                     4 executor: docker (1 container per session) | local (dev)
                         └ agentd (inside container): claude | codex | opencode | hermes | mock
                     5 normalizer: agentd NDJSON → Responses SSE
                     6 store (SQLite): responses, sessions, route_decisions, outcomes, feedback
                   dashboard (static, served at /dashboard)
```

### Packages

| Path | Role |
|---|---|
| `packages/core` | Shared types: normalized run events, catalog, route decision, request schema (zod) |
| `packages/router` | Jev client (raw fetch, AbortSignal deadline), question set, scorer, heuristic fallback, LRU cache, outcome priors |
| `packages/agentd` | In-sandbox runner. `agentd run` reads a JSON RunSpec on stdin, spawns the harness CLI headless, emits normalized NDJSON events on stdout. Bundled to one file with esbuild. |
| `apps/gateway` | HTTP API, executors, store, SSE mapping, dashboard |
| `docker/agent-runtime` | Image with all four harness CLIs + agentd |

### Routing

1. **Eligibility (code):** drop catalog options whose harness isn't installed / whose provider
   key is missing / whose estimated cost exceeds `max_cost_usd`; honour pinned harness/model.
2. **Jev (one batched call):** `task_type` (choice), `difficulty` (score 1–5), `edits_code`,
   `long_horizon`, `needs_web` (noul), and `best_option` (choice over eligible options with
   one-line descriptions). Jev reads questions literally and is bad at maths, so all
   thresholds and arithmetic stay in code.
3. **Scorer (code):** `score = quality_fit − λ(objective) · normalized_cost + prior_bonus`, where
   quality_fit combines option tier vs difficulty, harness/task affinity and Jev's
   `best_option` probability; priors come from logged outcomes (success rate, feedback) per
   (task_type, option) with a Beta prior so they only matter once data exists.
4. **Effort** chosen from difficulty × objective, mapped to each harness's native knob.
5. **Fallback:** Jev timeout (default 900 ms) / error / no key → keyword heuristics produce
   the same feature set; the decision records `source: "jev" | "heuristic" | "cache" | "pinned"`.

Every decision is stored with its features and candidate scores, and returned in the response
`metadata.route` so callers can see *why*.

### Isolation

Docker executor: one container per session (`--network` configurable, `--cpus`, `--memory`,
`--pids-limit`, non-root user, `no-new-privileges`, all caps dropped), workspace under
`/workspace`, kept alive between turns for continuation and reaped after idle TTL. Keys are
passed per exec as env vars, never baked into images; outputs are redacted of key values.

### API (HarnessRouter-compatible subset + extensions)

- `POST /v1/responses` — `{input, model?, stream?, previous_response_id?, reasoning?: {effort},
  metadata: {harness_id: "auto"|"claude-code"|"codex"|"opencode"|"hermes"}, routing?: {objective, max_cost_usd}}`
- `GET /v1/responses/:id`, `POST /v1/responses/:id/cancel`
- `POST /v1/responses/:id/feedback` — `{score: 0..1}` (feeds routing priors)
- `POST /v1/route` — dry-run routing decision (no execution)
- `GET /v1/harnesses`, `GET /v1/models`, `GET /v1/stats`
- SSE: `response.created`, `response.in_progress`, `response.output_item.added`,
  `response.output_text.delta`, `response.output_item.done`, and exactly one terminal
  `response.completed | response.incomplete | response.failed`.

### Error handling

Structured error envelope `{error: {type, code, message}}`. Harness crash → `response.failed`
with stderr tail (redacted). Container start failure → 503 `sandbox_unavailable`. Budget
exceeded before run → 402-style `budget_exceeded` with the cheapest eligible estimate.
Idempotency-Key replays return the stored response.

### Testing

Vitest. `mock` harness in agentd makes the whole pipeline testable without keys or Docker:
router unit tests (scorer, fallback, deadline, cache), driver parser tests on recorded
fixtures for each harness's JSON stream, gateway integration tests (local executor + mock
harness + stubbed Jev), and an opt-in Docker e2e test.

## Out of scope for MVP

Billing, multi-tenant orgs, cloud sandboxes (E2B/Vercel), file upload API, MCP secrets vault.
