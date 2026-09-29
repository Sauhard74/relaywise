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
let lastJevState = "";

/** Stub Jev: "hard" prompts get difficulty 4, everything else trivial. */
const fakeJevFetch = (async (_url: string, init: RequestInit) => {
  jevCalls++;
  const { state } = JSON.parse(String(init.body)) as { state: string };
  lastJevState = state;
  const request = state.includes("New request:") ? state.slice(state.lastIndexOf("New request:")) : state;
  const hard = /refactor|architecture/i.test(request);
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
  process.env.MOCK_PACE_MS = "0";
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
    const d = await res.json();
    expect(d).toMatchObject({ object: "uhp.discovery", protocol: "uhp", default_version: "2026-09-12", conformance_class: "core" });
    expect(d.capabilities).toMatchObject({ streaming: true, cancellation: true, "jevroute.auto_routing": true });
  });

  it("rejects missing keys with the error envelope", async () => {
    const res = await app.request("/v1/harnesses");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatchObject({ type: "authentication_error", code: "missing_credential" });
    const bad = await app.request("/v1/harnesses", { headers: { Authorization: "Bearer nope" } });
    expect((await bad.json()).error.code).toBe("invalid_credential");
    expect(body.detail).toBeTruthy();
  });

  it("lists auto plus harnesses with availability", async () => {
    const body = await (await get("/v1/harnesses")).json();
    expect(body.harnesses[0]).toMatchObject({ id: "chrn_auto", base: "auto", available: true, routing: { engine: "jev" } });
    expect(body.harnesses.find((h: any) => h.base === "mock")).toMatchObject({ id: "chrn_mock", available: true });
    expect((await (await get("/v1/harnesses/mock")).json()).id).toBe("chrn_mock");
    const models = await (await get("/v1/models")).json();
    expect(models.backends.mock).toMatchObject({ default: "mock-small" });
    expect(models.backends.auto.models[0]).toMatchObject({ id: "auto", available: true });
    expect((await (await get("/v1/harnesses/chrn_mock/models")).json()).models).toHaveLength(2);
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
    expect(second.metadata.route).toMatchObject({ source: "jev", handoff: false }); // auto sessions re-route per turn
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
    expect(body.error.code).toBe("jevroute.budget_exceeded");
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
    const r = await (await post("/chrn_mock/v1/responses", { input: "path style" })).json();
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

describe("sessions across models (ledger memory)", () => {
  it("re-routes each turn of an auto session, with earlier turns as context", async () => {
    const t1 = await (await post("/v1/responses", { input: "create notes MOCK_WRITE notes.md" })).json();
    expect(t1.model).toBe("mock-small");
    expect(t1.metadata.checkpoint).toMatchObject({ turn: 1, files: [{ status: "A", path: "notes.md" }] });

    const t2 = await (
      await post("/v1/responses", { input: "now refactor the architecture around it", previous_response_id: t1.id })
    ).json();
    expect(lastJevState).toContain("Earlier turns in this session or project:");
    expect(lastJevState).toContain("notes.md");
    expect(t2.model).toBe("mock-large"); // harder follow-up → stronger model
    expect(t2.metadata.route).toMatchObject({ source: "jev", handoff: false }); // same harness: native resume
    expect(t2.output_text).toContain("(resumed)");
    expect(t2.metadata.checkpoint.turn).toBe(2);
    expect(t2.metadata.session_id).toBe(t1.metadata.session_id);
  });

  it("briefs a different harness from the ledger instead of resuming", async () => {
    const t1 = await (await post("/v1/responses", { input: "first step MOCK_WRITE a.txt" })).json();
    // Pretend turn 1 ran on another harness, so turn 2 (on mock) is a cross-harness handoff.
    store.updateSession(t1.metadata.session_id, { harness: "codex", model: "gpt-5.6-terra" });
    const t2 = await (await post("/v1/responses", { input: "second step", previous_response_id: t1.id })).json();
    expect(t2.metadata.route.handoff).toBe(true);
    expect(t2.output_text).toContain("(briefed) done: second step");
    expect(t2.output_text).not.toContain("(resumed)");
  });

  it("keeps pinned sessions on their harness", async () => {
    const t1 = await (await post("/v1/responses", { input: "hi", metadata: { harness_id: "mock" } })).json();
    const t2 = await (
      await post("/v1/responses", { input: "refactor the architecture", previous_response_id: t1.id, metadata: { harness_id: "mock" } })
    ).json();
    expect(t2.metadata.route.source).toBe("session");
    expect(t2.model).toBe(t1.model);
  });
});

describe("projects: memory that outlives sessions", () => {
  it("carries files and the ledger into a brand-new session", async () => {
    const s1 = await (await post("/v1/responses", { input: "start MOCK_WRITE plan.md", metadata: { project_id: "demo" } })).json();
    expect(s1.metadata.project_id).toBe("demo");
    expect(s1.metadata.route.handoff).toBeFalsy();

    // No previous_response_id: a new session, same project.
    const s2 = await (await post("/v1/responses", { input: "continue the plan", metadata: { project_id: "demo" } })).json();
    expect(s2.metadata.session_id).not.toBe(s1.metadata.session_id);
    expect(s2.metadata.route.handoff).toBe(true);
    expect(s2.output_text).toContain("(briefed) done: continue the plan");
    expect(lastJevState).toContain("start MOCK_WRITE plan.md"); // routed with project history
    expect(s2.metadata.checkpoint.turn).toBe(2); // turn numbering continues across sessions

    const memory = await (await get("/v1/projects/demo/memory")).text();
    expect(memory).toContain(`## Turn 1`);
    expect(memory).toContain(s1.metadata.session_id);
    expect(memory).toContain(s2.metadata.session_id);
    expect(await (await get("/v1/projects/demo/memory?turn=1")).text()).toContain("### Request");

    const info = await (await get("/v1/projects/demo")).json();
    expect(info).toMatchObject({ id: "demo", sessions: 2, turns: 2, busy: false });
  });

  it("runs one turn at a time per project", async () => {
    const running = await (await post("/v1/responses", { input: "MOCK_SLOW work", background: true, metadata: { project_id: "busy" } })).json();
    const clash = await post("/v1/responses", { input: "other", metadata: { project_id: "busy" } });
    expect(clash.status).toBe(409);
    expect((await clash.json()).error.code).toBe("jevroute.project_busy");
    await post(`/v1/responses/${running.id}/cancel`, {});
    const after = await post("/v1/responses", { input: "now it's free", metadata: { project_id: "busy" } });
    expect(after.status).toBe(200);
  });

  it("validates project ids and refuses to move a session between projects", async () => {
    expect((await post("/v1/responses", { input: "x", metadata: { project_id: "../etc" } })).status).toBe(400);
    const s1 = await (await post("/v1/responses", { input: "x", metadata: { project_id: "p1" } })).json();
    const res = await post("/v1/responses", { input: "y", previous_response_id: s1.id, metadata: { project_id: "p2" } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("jevroute.project_mismatch");
  });

  it("syncs a local tree in and hands back only the agent's changes as a patch", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const local = mkdtempSync(join(tmpdir(), "local-"));
    const tarOf = (files: string[]) =>
      execFileSync("tar", ["-cf", "-", ...files], { cwd: local, env: { ...process.env, COPYFILE_DISABLE: "1" } });
    writeFileSync(join(local, "a.txt"), "alpha\n");
    writeFileSync(join(local, "b.txt"), "beta\n");
    const sync = (files: string[]) =>
      app.request("/v1/projects/synced/sync", { method: "POST", headers: { Authorization: auth.Authorization }, body: tarOf(files) });

    const first = await (await sync(["a.txt", "b.txt"])).json();
    expect(first).toMatchObject({ object: "project.sync", files_changed: 3 }); // a, b, .gitignore
    rmSync(join(local, "b.txt"));
    const second = await (await sync(["a.txt"])).json();
    expect(second.files_changed).toBe(1); // b.txt deleted

    const turn = await (await post("/v1/responses", { input: "add MOCK_WRITE c.txt", metadata: { project_id: "synced" } })).json();
    const patch = await (await get(`/v1/projects/synced/diff?commit=${turn.metadata.checkpoint.commit}`)).text();
    expect(patch).toContain("c.txt");
    expect(patch).not.toContain(".jev/");
    expect(patch).not.toContain("b.txt");
    execFileSync("git", ["apply"], { cwd: local, input: patch });
    expect(execFileSync("cat", ["c.txt"], { cwd: local, encoding: "utf8" })).toBe("written by mock-small\n");
    expect((await get("/v1/projects/synced/diff?commit=zzz")).status).toBe(400);
  });

  it("deletes a project and its memory", async () => {
    await post("/v1/responses", { input: "x", metadata: { project_id: "gone" } });
    expect((await app.request("/v1/projects/gone", { method: "DELETE", headers: auth })).status).toBe(200);
    expect((await get("/v1/projects/gone")).status).toBe(404);
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

  it("reaps idle sessions without touching a busy one", async () => {
    const idle = store.createSession({ id: "sess_idle", harness: "mock", model: "mock-small" });
    const busy = store.createSession({ id: "sess_busy", harness: "mock", model: "mock-small" });
    store.updateSession(idle.id, { sandbox_id: "x1", last_used_at: 0 });
    store.updateSession(busy.id, { sandbox_id: "x2", last_used_at: 0, busy: 1 });
    await service.reap(Date.now());
    expect(store.getSession(idle.id)).toMatchObject({ sandbox_id: null, busy: 0 });
    expect(store.getSession(busy.id)).toMatchObject({ sandbox_id: "x2", busy: 1 });
    expect(store.lockForReap(busy.id, Date.now())).toBe(false);
  });

  it("gates options on their own credentials", () => {
    const chatgptOnly = DEFAULT_CATALOG.options.find((o) => o.id === "codex:gpt-5.6-luna")!;
    expect(chatgptOnly.auth_env).toEqual(["CODEX_AUTH_JSON"]);
    expect(DEFAULT_CATALOG.options.find((o) => o.id === "codex:gpt-6-luna")!.auth_env).not.toContain("CODEX_AUTH_JSON");
  });

  it("rejects absurd timeouts instead of overflowing the timer", async () => {
    expect((await post("/v1/responses", { input: "x", timeout_seconds: 1e9 })).status).toBe(400);
  });

  it("serves the dashboard", async () => {
    const res = await app.request("/dashboard");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("jev-route");
  });
});
