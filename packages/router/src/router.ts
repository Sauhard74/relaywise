import { createHash } from "node:crypto";
import {
  estimateCostUsd,
  optionId,
  type Catalog,
  type CatalogOption,
  type Effort,
  type HarnessId,
  type Objective,
  type RouteDecision,
  type RouteFeatures,
  type RouteSource,
} from "@relaywise/core";
import { TtlCache } from "./cache.ts";
import { heuristicFeatures } from "./heuristic.ts";
import type { JevClient } from "./jev.ts";
import { buildQuestions, compactState, parseAnswers, type ParsedAnswers } from "./questions.ts";
import { scoreOptions, type PriorsProvider } from "./scorer.ts";

export interface RouteRequest {
  prompt: string;
  objective?: Objective;
  max_cost_usd?: number;
  /** Caller-pinned choices. A pinned harness narrows the pool; harness+model skips routing. */
  pin?: { harness?: HarnessId; model?: string; effort?: Effort };
  /** Earlier turns of the session, so Jev judges follow-ups ("now add tests") in context. */
  context?: string;
  /** The harness/model that ran the previous turn; staying on it avoids a handoff. */
  continuity?: { harness: HarnessId; model: string };
}

export class RouteError extends Error {
  constructor(
    readonly code: "no_eligible_option" | "budget_exceeded",
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RouteError";
  }
}

export interface RouterOptions {
  catalog: Catalog;
  jev?: JevClient;
  /** Hard deadline for the Jev call. The heuristic takes over past it. */
  deadlineMs?: number;
  priors?: PriorsProvider;
  /** Filters options the deployment can actually run (harness installed, key present). */
  isAvailable?: (option: CatalogOption) => boolean;
  cache?: TtlCache<ParsedAnswers>;
  now?: () => number;
}

export class Router {
  private readonly deadlineMs: number;
  private readonly cache: TtlCache<ParsedAnswers>;
  private readonly now: () => number;

  constructor(private readonly opts: RouterOptions) {
    this.deadlineMs = opts.deadlineMs ?? 900;
    this.cache = opts.cache ?? new TtlCache();
    this.now = opts.now ?? performance.now.bind(performance);
  }

  eligibleOptions(pin?: RouteRequest["pin"]): CatalogOption[] {
    const available = this.opts.isAvailable ?? (() => true);
    return this.opts.catalog.options.filter(
      (o) => available(o) && (!pin?.harness || o.harness === pin.harness) && (!pin?.model || o.model === pin.model),
    );
  }

  async route(req: RouteRequest): Promise<RouteDecision> {
    const started = this.now();
    const objective = req.objective ?? "balanced";
    const pin = req.pin ?? {};

    if (pin.harness && pin.model) return this.pinned(req, objective, started);

    const pool = this.eligibleOptions(pin);
    if (pool.length === 0) {
      throw new RouteError(
        "no_eligible_option",
        pin.harness
          ? `no runnable model for harness '${pin.harness}' (is it installed and is its API key set?)`
          : "no harness is runnable: set at least one provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY)",
      );
    }

    const { parsed, source, fallback_reason } = await this.classify(req.prompt, pool, req.context);

    const scored = scoreOptions({
      catalog: this.opts.catalog,
      options: pool,
      features: parsed.features,
      objective,
      optionProbabilities: parsed.optionProbabilities,
      priors: this.opts.priors?.stats(parsed.features.task_type),
      effortOverride: pin.effort,
      continuity: req.continuity,
    });

    const affordable =
      req.max_cost_usd === undefined ? scored : scored.filter((c) => c.est_cost_usd <= req.max_cost_usd!);
    if (affordable.length === 0) {
      const cheapest = [...scored].sort((a, b) => a.est_cost_usd - b.est_cost_usd)[0]!;
      throw new RouteError(
        "budget_exceeded",
        `every eligible option is estimated above max_cost_usd=${req.max_cost_usd}; cheapest is ${cheapest.option_id} at ~$${cheapest.est_cost_usd.toFixed(4)}`,
        { cheapest_option: cheapest.option_id, cheapest_est_cost_usd: cheapest.est_cost_usd },
      );
    }

    const best = affordable[0]!;
    const topTier = Math.max(...scored.map((c) => c.option.tier));
    const baseline = Math.max(...scored.filter((c) => c.option.tier === topTier).map((c) => c.est_cost_usd));
    return {
      harness: best.option.harness,
      model: best.option.model,
      effort: best.effort,
      option_id: best.option_id,
      source,
      objective,
      features: parsed.features,
      est_cost_usd: best.est_cost_usd,
      baseline_est_cost_usd: baseline,
      latency_ms: Math.round(this.now() - started),
      candidates: affordable.slice(0, 5).map(({ option: _o, effort: _e, ...c }) => c),
      reason: explain(parsed.features, best.option, objective, source),
      ...(fallback_reason ? { fallback_reason } : {}),
    };
  }

  private async classify(
    prompt: string,
    pool: CatalogOption[],
    context?: string,
  ): Promise<{ parsed: ParsedAnswers; source: RouteSource; fallback_reason?: string }> {
    const heuristic = (reason: string) => ({
      parsed: { features: heuristicFeatures(prompt), optionProbabilities: {} },
      source: "heuristic" as const,
      fallback_reason: reason,
    });
    if (!this.opts.jev) return heuristic("jev not configured (set TYPESAFE_API_KEY)");

    // The new request goes last and is kept whole when possible; context is trimmed first.
    const request = compactState(prompt, 5000);
    const state = context ? `${compactState(context, Math.max(1000, 7000 - request.length))}\n\nNew request:\n${request}` : request;
    const key = cacheKey(state, pool);
    const hit = this.cache.get(key);
    if (hit) return { parsed: hit, source: "cache" };

    try {
      const res = await this.opts.jev.ask(state, buildQuestions(pool), AbortSignal.timeout(this.deadlineMs));
      const parsed = parseAnswers(res.answers);
      this.cache.set(key, parsed);
      return { parsed, source: "jev" };
    } catch (err) {
      return heuristic((err as Error).message);
    }
  }

  private pinned(req: RouteRequest, objective: Objective, started: number): RouteDecision {
    const harnessId = req.pin!.harness!;
    const model = req.pin!.model!;
    const harness = this.opts.catalog.harnesses[harnessId];
    const features = heuristicFeatures(req.prompt);
    const known = this.opts.catalog.options.find((o) => o.harness === harnessId && o.model === model);
    const est = known ? estimateCostUsd(known, harness, features.difficulty, req.pin!.effort) : 0;
    return {
      harness: harnessId,
      model,
      effort: req.pin!.effort,
      option_id: optionId(harnessId, model),
      source: "pinned",
      objective,
      features,
      est_cost_usd: est,
      latency_ms: Math.round(this.now() - started),
      candidates: [],
      reason: `caller pinned ${harness.label} with ${model}`,
    };
  }
}

function cacheKey(state: string, pool: CatalogOption[]): string {
  return createHash("sha256")
    .update(state)
    .update("\0")
    .update(pool.map((o) => o.id).sort().join(","))
    .digest("hex");
}

function explain(f: RouteFeatures, o: CatalogOption, objective: Objective, source: RouteSource): string {
  const diff = ["trivial", "easy", "moderate", "hard", "very hard"][f.difficulty - 1];
  const via = source === "heuristic" ? "keyword fallback" : source === "cache" ? "cached Jev answer" : "Jev";
  const article = /^[aeiou]/.test(diff ?? "") ? "an" : "a";
  return `${via} read this as ${article} ${diff} ${f.task_type.replace("_", " ")} task; ${o.id} (tier ${o.tier}) scored best for objective '${objective}'`;
}
