# How routing works

For every task, relaywise picks an **agent** (Claude Code, Codex, OpenCode or Hermes), a
**model** for it, and a **reasoning effort** — the combination that fits the task, your objective
(`cheapest`, `balanced` or `best`) and your budget.

## The steps

1. **Eligibility.** Only options that can actually run are considered: the agent is installed in
   the sandbox image, its credentials are configured, and it isn't excluded by a pin
   (`--harness`, `--model`).
2. **Read the task with Jev.** One call to TypeSafe's [Jev](https://typesafe.ai) System One model,
   with a hard deadline (900 ms by default), answers five typed questions: what kind of task it is,
   how difficult it is (1–5), whether it edits code, whether it needs many steps, whether it needs
   the web — plus which eligible option fits best, judged on capability only (Jev is poor at
   arithmetic, so prices stay out of its prompt). Follow-up turns include a digest of earlier turns
   so "now add tests for it" is judged in context. Answers are cached.
3. **Score in code.** Each option gets
   `tier fit + task affinity + Jev's preference + outcome prior − cost weight(objective) × cost`.
   Sending a hard task to a weak model is penalised much more than the reverse. The outcome prior
   comes from past runs of the same task type (explicit feedback when given, otherwise
   completed/failed), shrunk towards neutral until there is data. Observed actual/estimated cost
   ratios recalibrate the estimates. A small bonus for staying on the previous turn's agent avoids
   switching without reason.
4. **Effort** follows difficulty and objective, mapped to each agent's own setting
   (`claude --effort`, Codex `model_reasoning_effort`).
5. **Budget.** Options estimated above `max_cost_usd` are dropped; if none remain the request
   fails fast with `relaywise.budget_exceeded` and the cheapest estimate.
6. **Fallback.** No key, a timeout, a 429/529 or a malformed answer falls back to keyword rules
   that produce the same features; the decision records `source: "heuristic"` and why.

Every response explains itself in `metadata.route`: the features, the chosen option and effort,
the estimate, the no-router baseline, the top candidates with their scores, and a one-line reason.

## Evaluation

`pnpm eval:router` runs the router over 40 labelled tasks
([`packages/router/eval/dataset.jsonl`](../packages/router/eval/dataset.jsonl)). With
`TYPESAFE_API_KEY` set it evaluates Jev, otherwise the keyword fallback.

| Engine, objective | Right tier | Too weak | Too strong | Est. saving vs top tier | Latency p50 / p95 |
|---|---|---|---|---|---|
| Jev, balanced | 90–95% | 2.5–5% | 2.5–5% | 41% | 336 / 420 ms |
| Jev, best | 95% | 0% | 5% | 41% | 359 / 448 ms |
| Jev, cheapest | 72.5% | 27.5% (by design) | 0% | 58% | 349 / 398 ms |
| Keyword fallback, balanced | 80% | 7.5% | 12.5% | 37% | < 1 ms |

Measured with `jev-latest` in September 2026. Jev answers vary a little between runs (the balanced
range spans two runs). The fallback rules and the labels were written together, so read the
fallback row as an upper bound. Add your own tasks to the dataset.

## Configuration

The catalog of agents, models and prices lives in
[`packages/core/src/catalog.ts`](../packages/core/src/catalog.ts); replace it with
`RELAYWISE_CATALOG=catalog.json` (`{"options": [...], "harnesses": {...}}`). Point
`TYPESAFE_BASE_URL` at any wire-compatible System One server (for example a self-hosted OpenJev)
to avoid depending on TypeSafe. `JEV_MODEL` and `JEV_DEADLINE_MS` tune the call.
