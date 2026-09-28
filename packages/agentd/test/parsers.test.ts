import { describe, expect, it } from "vitest";
import type { RunEvent, RunSpec } from "@jev-route/core";
import { claudeDriver } from "../src/drivers/claude.ts";
import { codexDriver } from "../src/drivers/codex.ts";
import { opencodeDriver } from "../src/drivers/opencode.ts";
import type { Driver } from "../src/driver.ts";

const spec: RunSpec = {
  run_id: "r1",
  harness: "claude-code",
  model: "m",
  prompt: "p",
  cwd: "/workspace",
  env: {},
};

async function feed(driver: Driver, lines: object[], exitCode = 0): Promise<RunEvent[]> {
  const p = driver.parser(spec);
  const events = lines.flatMap((l) => p.line(JSON.stringify(l)));
  return [...events, ...(await p.end(exitCode))];
}

describe("claude stream-json", () => {
  it("normalizes a full turn", async () => {
    const events = await feed(claudeDriver, [
      { type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-5" },
      { type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
      { type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
      { type: "assistant", session_id: "sess-1", message: { content: [{ type: "text", text: "Hello" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", session_id: "sess-1", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "a.txt" }] }] } },
      { type: "result", subtype: "success", is_error: false, result: "Hello", total_cost_usd: 0.0123, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 }, session_id: "sess-1" },
    ]);
    expect(events).toEqual([
      { type: "session", harness_session_id: "sess-1" },
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "text_done", text: "Hello" },
      { type: "tool_call", call_id: "tu1", name: "Bash", arguments: '{"command":"ls"}' },
      { type: "tool_result", call_id: "tu1", output: "a.txt" },
      { type: "usage", input_tokens: 15, output_tokens: 7, cache_read_tokens: 100, cost_usd: 0.0123 },
    ]);
  });

  it("reports error results", async () => {
    const events = await feed(claudeDriver, [
      { type: "result", subtype: "error_max_turns", is_error: true, usage: {}, session_id: "s" },
    ], 1);
    expect(events.some((e) => e.type === "error" && e.code === "error_max_turns")).toBe(true);
  });

  it("builds resume + effort flags", () => {
    const cmd = claudeDriver.build({ ...spec, effort: "high", harness_session_id: "abc" });
    expect(cmd.args).toEqual(expect.arrayContaining(["--effort", "high", "--resume", "abc", "--model", "m"]));
  });
});

describe("codex exec --json", () => {
  it("normalizes a full turn and nets cached tokens out of input", async () => {
    const events = await feed(codexDriver, [
      { type: "thread.started", thread_id: "th-9" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i0", type: "reasoning", text: "thinking" } },
      { type: "item.started", item: { id: "i1", type: "command_execution", command: "ls", status: "in_progress" } },
      { type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "a.txt\n", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "i2", type: "agent_message", text: "Done." } },
      { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } },
    ]);
    expect(events).toEqual([
      { type: "session", harness_session_id: "th-9" },
      { type: "reasoning", text: "thinking" },
      { type: "tool_call", call_id: "i1", name: "shell", arguments: '{"command":"ls"}' },
      { type: "tool_result", call_id: "i1", output: "a.txt\n" },
      { type: "text_done", text: "Done." },
      { type: "usage", input_tokens: 400, output_tokens: 50, cache_read_tokens: 600 },
    ]);
  });

  it("maps turn.failed to an error", async () => {
    const events = await feed(codexDriver, [{ type: "turn.failed", error: { message: "quota" } }], 1);
    expect(events).toContainEqual({ type: "error", code: "turn_failed", message: "quota" });
  });

  it("puts resume flags in the order codex accepts", () => {
    const fresh = codexDriver.build({ ...spec, harness: "codex", effort: "xhigh" }).args;
    expect(fresh.slice(0, 5)).toEqual(["exec", "--color", "never", "--cd", "/workspace"]);
    expect(fresh).toContain('model_reasoning_effort="xhigh"');
    const resumed = codexDriver.build({ ...spec, harness: "codex", harness_session_id: "th-9" }).args;
    expect(resumed.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(resumed).not.toContain("--cd");
    expect(resumed.slice(-2)).toEqual(["th-9", "p"]);
  });
});

describe("opencode run --format json", () => {
  it("accumulates text parts and sums step usage", async () => {
    const events = await feed(opencodeDriver, [
      { type: "step_start", sessionID: "ses_1", part: {} },
      { type: "text", sessionID: "ses_1", part: { type: "text", text: "Look" } },
      { type: "tool_use", sessionID: "ses_1", part: { type: "tool", callID: "c1", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "x" } } },
      { type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 20 } }, cost: 0.001 } },
      { type: "text", sessionID: "ses_1", part: { type: "text", text: "ing good" } },
      { type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.002 } },
    ]);
    expect(events).toEqual([
      { type: "session", harness_session_id: "ses_1" },
      { type: "text_delta", text: "Look" },
      { type: "text_done", text: "Look" },
      { type: "tool_call", call_id: "c1", name: "bash", arguments: '{"command":"ls"}' },
      { type: "tool_result", call_id: "c1", output: "x" },
      { type: "text_delta", text: "ing good" },
      { type: "text_done", text: "ing good" },
      { type: "usage", input_tokens: 320, output_tokens: 35, cache_read_tokens: 50, cost_usd: 0.003 },
    ]);
  });
});
