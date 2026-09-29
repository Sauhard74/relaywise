import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CATALOG, type Catalog, type CatalogOption } from "@relaywise/core";
import {
  JevClient,
  Router,
  RouteError,
  chooseEffort,
  heuristicFeatures,
  parseAnswers,
  scoreOptions,
  type JevResponse,
  type OptionStats,
} from "../src/index.ts";

const catalog: Catalog = DEFAULT_CATALOG;
const real = (o: CatalogOption) => o.harness !== "mock";

function jevReturning(answers: JevResponse["answers"], delayMs = 0) {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), { status: 200 });
  });
  return { client: new JevClient({ apiKey: "k", fetch: fetchImpl as typeof fetch }), fetchImpl };
}

const hardCoding: JevResponse["answers"] = {
  task_type: { type: "choice", choice: "code_change", confidence: 0.9, probabilities: { code_change: 0.9 } },
  difficulty: { type: "score", score: 3.8, confidence: 0.8 },
  edits_code: { type: "noul", noul: 0.97 },
  long_horizon: { type: "noul", noul: 0.9 },
  needs_web: { type: "noul", noul: 0.05 },
  best_option: {
    type: "choice",
    choice: "claude-code:claude-opus-5",
    confidence: 0.6,
    probabilities: { "claude-code:claude-opus-5": 0.6, "codex:gpt-6-astra": 0.3 },
  },
};

const trivial: JevResponse["answers"] = {
  task_type: { type: "choice", choice: "quick_answer", confidence: 0.9, probabilities: {} },
  difficulty: { type: "score", score: 0.1, confidence: 0.9 },
  edits_code: { type: "noul", noul: 0.02 },
  long_horizon: { type: "noul", noul: 0.01 },
  needs_web: { type: "noul", noul: 0.0 },
};

describe("parseAnswers", () => {
  it("maps the probability-weighted score index to 1-based difficulty", () => {
    const p = parseAnswers(hardCoding);
    expect(p.features).toEqual({
      task_type: "code_change",
      difficulty: 5,
      edits_code: true,
      long_horizon: true,
      needs_web: false,
    });
    expect(p.optionProbabilities["claude-code:claude-opus-5"]).toBe(0.6);
  });

  it("rejects answers without a task type", () => {
    expect(() => parseAnswers({ difficulty: { type: "score", score: 1, confidence: 1 } })).toThrow(/task_type/);
  });
});

describe("chooseEffort", () => {
  const f = heuristicFeatures("x");
  it("returns undefined for harnesses without an effort knob", () => {
    expect(chooseEffort({ ...f, difficulty: 5 }, "best", [])).toBeUndefined();
  });
  it("scales with difficulty and objective", () => {
    const all = ["low", "medium", "high", "xhigh", "max"] as const;
    expect(chooseEffort({ ...f, difficulty: 1 }, "balanced", all)).toBe("low");
    expect(chooseEffort({ ...f, difficulty: 4 }, "balanced", all)).toBe("high");
    expect(chooseEffort({ ...f, difficulty: 4 }, "cheapest", all)).toBe("medium");
    expect(chooseEffort({ ...f, difficulty: 5 }, "best", all)).toBe("max");
  });
});

describe("scoreOptions", () => {
  const options = catalog.options.filter(real);

  it("prefers a cheap tier for trivial tasks and a frontier tier for very hard ones", () => {
    const easy = scoreOptions({
      catalog,
      options,
      features: parseAnswers(trivial).features,
      objective: "balanced",
      optionProbabilities: {},
    });
    expect(easy[0]!.option.tier).toBe(1);

    const hard = scoreOptions({
      catalog,
      options,
      features: parseAnswers(hardCoding).features,
      objective: "balanced",
      optionProbabilities: {},
    });
    expect(hard[0]!.option.tier).toBe(3);
  });

  it("objective=cheapest never picks something pricier than objective=best", () => {
    const features = { ...parseAnswers(hardCoding).features, difficulty: 3 as const };
    const cheap = scoreOptions({ catalog, options, features, objective: "cheapest", optionProbabilities: {} })[0]!;
    const best = scoreOptions({ catalog, options, features, objective: "best", optionProbabilities: {} })[0]!;
    expect(cheap.est_cost_usd).toBeLessThanOrEqual(best.est_cost_usd);
  });

  it("bad observed outcomes demote an option", () => {
    const features = parseAnswers(hardCoding).features;
    const base = scoreOptions({ catalog, options, features, objective: "balanced", optionProbabilities: {} });
    const top = base[0]!.option_id;
    const priors = new Map<string, OptionStats>([[top, { runs: 40, quality: 0.1, cost_ratio: 1 }]]);
    const after = scoreOptions({ catalog, options, features, objective: "balanced", optionProbabilities: {}, priors });
    expect(after[0]!.option_id).not.toBe(top);
  });
});

describe("Router", () => {
  it("routes with Jev and reports why", async () => {
    const { client } = jevReturning(hardCoding);
    const router = new Router({ catalog, jev: client, isAvailable: real });
    const d = await router.route({ prompt: "Migrate the whole payments service to the new event bus." });
    expect(d.source).toBe("jev");
    expect(d.features.difficulty).toBe(5);
    expect(d.harness).toBe("claude-code");
    expect(d.model).toBe("claude-opus-5");
    expect(d.effort).toBe("xhigh");
    expect(d.candidates.length).toBeGreaterThan(1);
    expect(d.reason).toMatch(/Jev/);
  });

  it("falls back to the heuristic when Jev misses the deadline", async () => {
    const { client } = jevReturning(hardCoding, 500);
    const router = new Router({ catalog, jev: client, isAvailable: real, deadlineMs: 30 });
    const d = await router.route({ prompt: "fix the typo in README" });
    expect(d.source).toBe("heuristic");
    expect(d.fallback_reason).toMatch(/deadline/);
    expect(d.latency_ms).toBeLessThan(400);
  });

  it("falls back when Jev returns an HTTP error", async () => {
    const fetchImpl = vi.fn(async () => new Response("overloaded", { status: 529 }));
    const router = new Router({
      catalog,
      jev: new JevClient({ apiKey: "k", fetch: fetchImpl as unknown as typeof fetch }),
      isAvailable: real,
    });
    const d = await router.route({ prompt: "explain how the cache works" });
    expect(d.source).toBe("heuristic");
    expect(d.fallback_reason).toMatch(/529/);
  });

  it("caches Jev answers for identical prompts", async () => {
    const { client, fetchImpl } = jevReturning(trivial);
    const router = new Router({ catalog, jev: client, isAvailable: real });
    await router.route({ prompt: "what is 2+2" });
    const again = await router.route({ prompt: "what is 2+2" });
    expect(again.source).toBe("cache");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("respects a pinned harness", async () => {
    const { client } = jevReturning(hardCoding);
    const router = new Router({ catalog, jev: client, isAvailable: real });
    const d = await router.route({ prompt: "big refactor", pin: { harness: "codex" } });
    expect(d.harness).toBe("codex");
    expect(d.model).toBe("gpt-6-astra");
  });

  it("skips routing entirely when harness and model are pinned", async () => {
    const { client, fetchImpl } = jevReturning(hardCoding);
    const router = new Router({ catalog, jev: client, isAvailable: real });
    const d = await router.route({ prompt: "anything", pin: { harness: "codex", model: "gpt-5.5", effort: "high" } });
    expect(d).toMatchObject({ source: "pinned", harness: "codex", model: "gpt-5.5", effort: "high" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces max_cost_usd", async () => {
    const { client } = jevReturning(hardCoding);
    const router = new Router({ catalog, jev: client, isAvailable: real });
    const d = await router.route({ prompt: "big refactor", max_cost_usd: 0.5 });
    expect(d.est_cost_usd).toBeLessThanOrEqual(0.5);

    await expect(router.route({ prompt: "big refactor", max_cost_usd: 0.000001 })).rejects.toMatchObject({
      code: "budget_exceeded",
    });
  });

  it("errors clearly when nothing is runnable", async () => {
    const router = new Router({ catalog, isAvailable: () => false });
    await expect(router.route({ prompt: "hi" })).rejects.toBeInstanceOf(RouteError);
  });
});

describe("heuristicFeatures", () => {
  it("spots debugging and hard work", () => {
    const f = heuristicFeatures(
      "There's a race condition across the codebase causing intermittent crash in the scheduler; debug and fix it.",
    );
    expect(f.task_type).toBe("debugging");
    expect(f.difficulty).toBeGreaterThanOrEqual(3);
  });
  it("treats file-creating requests as code changes", () => {
    const f = heuristicFeatures("Create a file hello.py that prints the first 10 Fibonacci numbers and run it.");
    expect(f.task_type).toBe("code_change");
    expect(f.edits_code).toBe(true);
  });
  it("stacks several hard signals", () => {
    expect(heuristicFeatures("Intermittent race condition across the codebase in the scheduler; fix it.").difficulty).toBeGreaterThanOrEqual(4);
  });
  it("treats short questions as quick answers", () => {
    expect(heuristicFeatures("capital of France?").task_type).toBe("quick_answer");
  });
});
