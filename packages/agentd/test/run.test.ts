import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunEvent, RunSpec } from "@relaywise/core";
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

  it("commits each turn to the session ledger and briefs a handed-off agent", async () => {
    const { execFileSync } = await import("node:child_process");
    const { readFileSync, existsSync } = await import("node:fs");
    const cwd = mkdtempSync(join(tmpdir(), "ledger-"));

    const first = await collect(spec({ cwd, prompt: "create the file MOCK_WRITE app.txt", model: "mock-small" }));
    const cp1 = first.events.find((e) => e.type === "checkpoint");
    expect(cp1).toMatchObject({ turn: 1, files: [{ status: "A", path: "app.txt" }] });
    expect((cp1 as { commit: string }).commit).toMatch(/^[0-9a-f]{7,}$/);

    const second = await collect(spec({ cwd, prompt: "now extend it MOCK_WRITE lib.txt", model: "mock-large", handoff: true }));
    expect(second.events.find((e) => e.type === "text_done")).toMatchObject({ text: expect.stringContaining("(briefed) done: now extend it") });
    expect(second.events.find((e) => e.type === "checkpoint")).toMatchObject({ turn: 2, files: [{ status: "A", path: "lib.txt" }] });

    const memory = readFileSync(join(cwd, ".relay", "MEMORY.md"), "utf8");
    expect(memory).toContain("## Turn 1 — mock · mock-small");
    expect(memory).toContain("## Turn 2 — mock · mock-large");
    expect(memory).toContain("**Files:** A app.txt");
    expect(existsSync(join(cwd, ".relay", "turns", "0002.md"))).toBe(true);

    const log = execFileSync("git", ["log", "--format=%an|%s"], { cwd, encoding: "utf8" });
    expect(log).toContain("mock/mock-large|turn 2");
    expect(log).toContain("mock/mock-small|turn 1");
  });

  it("teaches every harness the session workflow without clobbering project instructions", async () => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const cwd = mkdtempSync(join(tmpdir(), "ledger-"));
    writeFileSync(join(cwd, "AGENTS.md"), "# Project rules\nUse tabs.\n");
    await collect(spec({ cwd }));
    await collect(spec({ cwd })); // idempotent: block is replaced, not duplicated
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("# Project rules\nUse tabs.");
    expect(agents.match(/relaywise:start/g)).toHaveLength(1);
    expect(agents).toContain("Start your final message with one or two sentences");
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toContain("@.relay/SKILL.md");
    expect(readFileSync(join(cwd, ".relay", "SKILL.md"), "utf8")).toContain("Session ledger");
  });

  it("summarises a turn from the agent's final message, not its progress chatter", async () => {
    const { recordTurn } = await import("../src/memory.ts");
    const cwd = mkdtempSync(join(tmpdir(), "ledger-"));
    const cp = await recordTurn(cwd, {
      harness: "codex",
      model: "m",
      status: "completed",
      prompt: "do it",
      finalText: "Added f_to_c next to c_to_f; nothing left.",
      fullText: "I'll look around first.\n\nAdded f_to_c next to c_to_f; nothing left.",
    });
    expect(cp?.summary).toBe("Added f_to_c next to c_to_f; nothing left.");
  });

  it("never commits harness internals", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const cwd = mkdtempSync(join(tmpdir(), "ledger-"));
    mkdirSync(join(cwd, ".harness"));
    writeFileSync(join(cwd, ".harness", "secret.json"), "{}");
    await collect(spec({ cwd }));
    expect(execFileSync("git", ["ls-files"], { cwd, encoding: "utf8" })).not.toContain(".harness");
  });

  it("can skip the ledger", async () => {
    const { existsSync } = await import("node:fs");
    const cwd = mkdtempSync(join(tmpdir(), "ledger-"));
    const { events } = await collect(spec({ cwd, ledger: false }));
    expect(events.some((e) => e.type === "checkpoint")).toBe(false);
    expect(existsSync(join(cwd, ".git"))).toBe(false);
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
