import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunEvent, RunSpec } from "@jev-route/core";
import { runHarness } from "../src/run.ts";

process.env.MOCK_PACE_MS = "0";

function spec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    run_id: `t${Math.random().toString(36).slice(2)}`,
    harness: "mock",
    model: "mock-small",
    prompt: "hello there",
    cwd: mkdtempSync(join(tmpdir(), "agentd-")),
    env: {},
    ...over,
  };
}

async function collect(s: RunSpec, signal?: AbortSignal) {
  const events: RunEvent[] = [];
  const status = await runHarness(s, (e) => events.push(e), signal);
  return { status, events };
}

describe("runHarness (mock harness, real process)", () => {
  it("completes and streams normalized events", async () => {
    const { status, events } = await collect(spec({ effort: "low" }));
    expect(status).toBe("completed");
    expect(events[0]).toMatchObject({ type: "started", harness: "mock" });
    expect(events.find((e) => e.type === "text_done")).toMatchObject({ text: "[mock-small/low] done: hello there" });
    expect(events.find((e) => e.type === "usage")).toBeTruthy();
    expect(events.at(-1)).toEqual({ type: "exit", status: "completed", exit_code: 0 });
  });

  it("reports harness failures", async () => {
    const { status, events } = await collect(spec({ prompt: "MOCK_FAIL please" }));
    expect(status).toBe("failed");
    expect(events).toContainEqual({ type: "error", code: "harness_error", message: "mock harness failure" });
    expect(events.at(-1)).toMatchObject({ type: "exit", status: "failed", exit_code: 3 });
  });

  it("cancels promptly", async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 300);
    const { status, events } = await collect(spec({ prompt: "MOCK_SLOW" }), ac.signal);
    expect(status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events.at(-1)).toMatchObject({ type: "exit", status: "cancelled" });
  });

  it("never reports a process killed from outside as completed", async () => {
    const { status, events } = await collect(spec({ prompt: "MOCK_KILL" }));
    expect(status).toBe("failed");
    expect(events.some((e) => e.type === "error" && e.code === "killed_by_signal")).toBe(true);
  });

  it("keeps prompts that start with a dash positional", async () => {
    const { status, events } = await collect(spec({ prompt: "- fix the bug" }));
    expect(status).toBe("completed");
    expect(events.find((e) => e.type === "text_done")).toMatchObject({ text: expect.stringContaining("-") });
  });

  it("enforces the timeout", async () => {
    const { status, events } = await collect(spec({ prompt: "MOCK_SLOW", timeout_ms: 300 }));
    expect(status).toBe("failed");
    expect(events.some((e) => e.type === "error" && e.code === "timeout")).toBe(true);
  });

  it("reports a missing harness binary", async () => {
    const s = spec({ harness: "hermes", model: "x", env: { PATH: "/nonexistent" } });
    const { status, events } = await collect(s);
    expect(status).toBe("failed");
    expect(events.some((e) => e.type === "error" && e.code === "harness_not_installed")).toBe(true);
  });

  it("redacts secret env values from output", async () => {
    const secret = "sk-test-SECRET-1234567890";
    const { events } = await collect(spec({ prompt: `echo ${secret}`, env: { OPENAI_API_KEY: secret } }));
    const text = JSON.stringify(events);
    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED]");
  });
});
