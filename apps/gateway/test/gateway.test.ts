import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CATALOG } from "@jev-route/core";
import { JevClient, Router } from "@jev-route/router";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { LocalExecutor } from "../src/executors/local.ts";
import { GatewayService } from "../src/service.ts";
import { Store, StorePriors } from "../src/store.ts";

const KEY = "test-key-123";
let jevCalls = 0;

/** Stub Jev: "hard" prompts get difficulty 4, everything else trivial. */
const fakeJevFetch = (async (_url: string, init: RequestInit) => {
  jevCalls++;
  const { state } = JSON.parse(String(init.body)) as { state: string };
  const hard = /refactor|architecture/i.test(state);
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        task_type: { type: "choice", choice: hard ? "code_change" : "quick_answer", confidence: 0.9, probabilities: {} },
        difficulty: { type: "score", score: hard ? 3.2 : 0.2, confidence: 0.9 },
        edits_code: { type: "noul", noul: hard ? 0.9 : 0.1 },
        long_horizon: { type: "noul", noul: hard ? 0.8 : 0.0 },
        needs_web: { type: "noul", noul: 0 },
      },
    }),
    { status: 200 },
  );
}) as unknown as typeof fetch;

let app: ReturnType<typeof createApp>;
let service: GatewayService;
let store: Store;

beforeAll(async () => {
  const cfg = loadConfig({
    JEV_ROUTE_EXECUTOR: "local",
    JEV_ROUTE_ENABLE_MOCK: "1",
    JEV_ROUTE_DB: ":memory:",
    JEV_ROUTE_WORKSPACES: mkdtempSync(join(tmpdir(), "jr-ws-")),
    TYPESAFE_API_KEY: "ts-key",
  });
  cfg.catalog = { ...DEFAULT_CATALOG, options: DEFAULT_CATALOG.options.filter((o) => o.harness === "mock") };
  store = new Store(":memory:");
  const priors = new StorePriors(store, 0);
  const executor = new LocalExecutor(cfg.workspacesDir, true);
  service = new GatewayService(
    cfg,
    store,
    executor,
    new Router({
      catalog: cfg.catalog,
      jev: new JevClient({ apiKey: "ts-key", fetch: fakeJevFetch }),
      priors,
      isAvailable: (o) => service.isOptionAvailable(o),
    }),
    priors,
  );
  await service.init();
  app = createApp(service, [KEY]);
});

afterAll(() => store.close());

const auth = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { ...auth, ...headers }, body: JSON.stringify(body) });
const get = (path: string) => app.request(path, { headers: auth });

async function sseEvents(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)) as { type: string; sequence_number: number; [k: string]: any });
}

describe("discovery and auth", () => {
  it("serves /v1/uhp without auth and echoes UHP-Version", async () => {
    const res = await app.request("/v1/uhp");
    expect(res.status).toBe(200);
    expect(res.headers.get("uhp-version")).toBe("2026-09-12");
    expect((await res.json()).capabilities.routing).toContain("auto");
  });

  it("rejects missing keys with the error envelope", async () => {
    const res = await app.request("/v1/harnesses");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatchObject({ type: "authentication_error", code: "invalid_api_key" });
    expect(body.detail).toBeTruthy();
  });

  it("lists auto plus harnesses with availability", async () => {
    const body = await (await get("/v1/harnesses")).json();
    expect(body.data[0]).toMatchObject({ id: "auto", available: true, routing: { engine: "jev" } });
    expect(body.data.find((h: any) => h.id === "mock")).toMatchObject({ available: true });
  });

  it("rejects unsupported protocol versions", async () => {
    const res = await app.request("/v1/models", { headers: { ...auth, "UHP-Version": "1999-01-01" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("unsupported_protocol_version");
  });
});

describe("POST /v1/responses", () => {
  it("routes with Jev and returns a completed response", async () => {
    const res = await post("/v1/responses", { input: "what is 2+2?", metadata: { harness_id: "auto" } });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ object: "response", status: "completed", model: "mock-small" });
    expect(r.metadata.route).toMatchObject({ source: "jev", harness: "mock", features: { task_type: "quick_answer" } });
    expect(r.output.at(-1)).toMatchObject({ type: "message", status: "completed" });
    expect(r.output_text).toContain("done: what is 2+2?");
    expect(r.usage.total_tokens).toBeGreaterThan(0);
    expect(r.metadata.cost_usd).toBeGreaterThan(0);
    expect(r.metadata.session_id).toMatch(/^sess_/);
  });

  it("sends harder work to the stronger option", async () => {
    const r = await (await post("/v1/responses", { input: "refactor the architecture of the billing module" })).json();
    expect(r.model).toBe("mock-large");
    expect(r.metadata.reasoning_effort).toBe("high");
  });

  it("streams gapless SSE with exactly one terminal event", async () => {
    const res = await post("/v1/responses", { input: "hello stream", stream: true });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await sseEvents(res);
    expect(events[0]!.type).toBe("response.created");
    expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i));
    const terminal = events.filter((e) => /^response\.(completed|failed|incomplete)$/.test(e.type));
    expect(terminal).toHaveLength(1);
    expect(events.at(-1)!.type).toBe("response.completed");
    const deltas = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
    expect(deltas).toBe(events.at(-1)!.response.output_text);
    expect(events.some((e) => e.type === "response.output_item.done" && e.item.type === "function_call")).toBe(true);
  });

  it("continues a session with previous_response_id", async () => {
    const first = await (await post("/v1/responses", { input: "turn one" })).json();
    const second = await (await post("/v1/responses", { input: "turn two", previous_response_id: first.id })).json();
    expect(second.metadata.session_id).toBe(first.metadata.session_id);
    expect(second.metadata.route.source).toBe("session");
    expect(second.output_text).toContain("(resumed)");
    expect(second.previous_response_id).toBe(first.id);
  });

  it("refuses to switch harness mid-session", async () => {
    const first = await (await post("/v1/responses", { input: "turn one" })).json();
    const res = await post("/v1/responses", { input: "x", previous_response_id: first.id, metadata: { harness_id: "codex" } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("harness_mismatch");
  });

  it("replays idempotent requests and rejects key reuse with a different body", async () => {
    const headers = { "Idempotency-Key": "idem-1" };
    const a = await (await post("/v1/responses", { input: "idempotent" }, headers)).json();
    const b = await (await post("/v1/responses", { input: "idempotent" }, headers)).json();
    expect(b.id).toBe(a.id);
    const c = await post("/v1/responses", { input: "different" }, headers);
    expect(c.status).toBe(409);
  });

  it("reports harness failures as a failed response, not an HTTP error", async () => {
    const res = await post("/v1/responses", { input: "MOCK_FAIL now" });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.status).toBe("failed");
    expect(r.error).toMatchObject({ type: "harness_error", code: "harness_error" });
  });

  it("cancels a running background response", async () => {
    const r = await (await post("/v1/responses", { input: "MOCK_SLOW job", background: true })).json();
    expect(r.status).toBe("in_progress");
    const t0 = Date.now();
    const c = await (await post(`/v1/responses/${r.id}/cancel`, {})).json();
    expect(c.status).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(2_000);
    // cancelling again is a no-op
    expect((await (await post(`/v1/responses/${r.id}/cancel`, {})).json()).status).toBe("cancelled");
  });

  it("enforces the cost budget before running", async () => {
    const res = await post("/v1/responses", { input: "anything", routing: { max_cost_usd: 1e-9 } });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("budget_exceeded");
    expect(body.error.detail.cheapest_option).toBeTruthy();
  });

  it("validates input and harness ids", async () => {
    expect((await post("/v1/responses", { input: "" })).status).toBe(400);
    const res = await post("/v1/responses", { input: "x", metadata: { harness_id: "nope" } });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("harness_not_found");
  });

  it("lists ignored fields instead of silently dropping them", async () => {
    const r = await (await post("/v1/responses", { input: "hi", temperature: 0.3, tools: [] })).json();
    expect(r.metadata.ignored_fields).toEqual(expect.arrayContaining(["temperature", "tools"]));
  });

  it("accepts HarnessRouter cloud-style paths", async () => {
    const r = await (await post("/mock/v1/responses", { input: "path style" })).json();
    expect(r.metadata.harness_id).toBe("mock");
    expect(r.metadata.route.source).toBe("jev");
  });

  it("accepts Responses-style input item arrays", async () => {
    const r = await (
      await post("/v1/responses", {
        input: [{ role: "user", content: [{ type: "input_text", text: "array input" }] }],
        instructions: "Be brief.",
      })
    ).json();
    expect(r.output_text).toContain("Be brief.");
  });
});

describe("routing endpoints, feedback and stats", () => {
  it("dry-runs a route without executing", async () => {
    const before = (await (await get("/v1/stats")).json()).totals.runs;
    const d = await (await post("/v1/route", { input: "refactor architecture" })).json();
    expect(d).toMatchObject({ harness: "mock", model: "mock-large" });
    expect(d.candidates.length).toBe(2);
    expect((await (await get("/v1/stats")).json()).totals.runs).toBe(before);
  });

  it("caches Jev answers for identical prompts", async () => {
    const calls = jevCalls;
    await post("/v1/route", { input: "cache me please" });
    const d = await (await post("/v1/route", { input: "cache me please" })).json();
    expect(d.source).toBe("cache");
    expect(jevCalls).toBe(calls + 1);
  });

  it("records feedback and learns from it", async () => {
    const r = await (await post("/v1/responses", { input: "rate me" })).json();
    expect((await post(`/v1/responses/${r.id}/feedback`, { score: 2 })).status).toBe(400);
    expect((await post(`/v1/responses/${r.id}/feedback`, { score: 0 })).status).toBe(200);
    const stats = store.optionStats("quick_answer");
    expect(stats.get("mock:mock-small")!.quality).toBeLessThan(1);
  });

  it("reports stats with savings vs the frontier baseline", async () => {
    const s = await (await get("/v1/stats")).json();
    expect(s.totals.runs).toBeGreaterThan(0);
    expect(s.savings.runs_counted).toBeGreaterThan(0);
    // trivial prompts ran on mock-small, so routing beat the mock-large baseline
    expect(s.savings.saved_usd).toBeGreaterThan(0);
  });

  it("lists recent runs for the dashboard", async () => {
    const list = await (await get("/v1/responses?limit=5")).json();
    expect(list.data.length).toBe(5);
    expect(list.data[0]).toHaveProperty("route_source");
  });

  it("serves the dashboard", async () => {
    const res = await app.request("/dashboard");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("jev-route");
  });
});
