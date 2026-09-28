/**
 * Offline routing eval over a labelled task set.
 *   pnpm eval:router                     → heuristic fallback only
 *   TYPESAFE_API_KEY=… pnpm eval:router  → Jev
 * Reports task-type accuracy, difficulty within ±1, tier under/over-provisioning, router
 * latency, and estimated spend vs always running the most capable option.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_CATALOG, type Difficulty, type Objective, type TaskType } from "@jev-route/core";
import { JevClient, Router } from "../src/index.ts";

interface Case {
  prompt: string;
  task_type: TaskType;
  difficulty: Difficulty;
  tier: 1 | 2 | 3;
}

const cases: Case[] = readFileSync(new URL("./dataset.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Case);

const objective = (process.env.OBJECTIVE ?? "balanced") as Objective;
const apiKey = process.env.TYPESAFE_API_KEY;
const router = new Router({
  catalog: DEFAULT_CATALOG,
  jev: apiKey ? new JevClient({ apiKey, baseUrl: process.env.TYPESAFE_BASE_URL, model: process.env.JEV_MODEL }) : undefined,
  deadlineMs: Number(process.env.JEV_DEADLINE_MS ?? 3000),
  isAvailable: (o) => o.harness !== "mock",
});
const tierOf = new Map(DEFAULT_CATALOG.options.map((o) => [o.id, o.tier]));

let typeOk = 0;
let diffOk = 0;
let tierExact = 0;
let under = 0;
let over = 0;
let spend = 0;
let baseline = 0;
let fallbacks = 0;
const latencies: number[] = [];
const misses: string[] = [];

for (const c of cases) {
  const d = await router.route({ prompt: c.prompt, objective });
  const tier = tierOf.get(d.option_id) ?? 2;
  if (d.source === "heuristic") fallbacks++;
  latencies.push(d.latency_ms);
  if (d.features.task_type === c.task_type) typeOk++;
  if (Math.abs(d.features.difficulty - c.difficulty) <= 1) diffOk++;
  if (tier === c.tier) tierExact++;
  else if (tier < c.tier) {
    under++;
    misses.push(`UNDER  t${tier}<t${c.tier}  ${d.option_id.padEnd(46)} ${c.prompt.slice(0, 70)}`);
  } else {
    over++;
    misses.push(`OVER   t${tier}>t${c.tier}  ${d.option_id.padEnd(46)} ${c.prompt.slice(0, 70)}`);
  }
  spend += d.est_cost_usd;
  baseline += d.baseline_est_cost_usd ?? d.est_cost_usd;
}

const pct = (n: number) => `${((100 * n) / cases.length).toFixed(1)}%`;
latencies.sort((a, b) => a - b);
console.log(`\nrouter eval — ${cases.length} cases, objective=${objective}, engine=${apiKey ? "jev" : "heuristic"}${fallbacks && apiKey ? ` (${fallbacks} fell back)` : ""}\n`);
console.log(`task type accuracy      ${pct(typeOk)}`);
console.log(`difficulty within ±1    ${pct(diffOk)}`);
console.log(`tier exact              ${pct(tierExact)}`);
console.log(`under-provisioned       ${pct(under)}   (hard task sent to a weaker tier — the costly mistake)`);
console.log(`over-provisioned        ${pct(over)}`);
console.log(`router latency p50/p95  ${latencies[Math.floor(latencies.length * 0.5)]} / ${latencies[Math.floor(latencies.length * 0.95)]} ms`);
console.log(`est. spend              $${spend.toFixed(2)} vs $${baseline.toFixed(2)} always-top-tier (${(100 - (100 * spend) / baseline).toFixed(0)}% saved)`);
if (misses.length) console.log(`\n${misses.join("\n")}`);
