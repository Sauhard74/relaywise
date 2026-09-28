import type { Driver } from "../driver.ts";

/**
 * Deterministic fake harness for tests and demos without API keys.
 * Runs a tiny node script so it exercises the real spawn/parse/cancel path.
 *   MOCK_FAIL in the prompt → harness error + non-zero exit
 *   MOCK_SLOW in the prompt → sleeps 30s between events (for cancel tests)
 *   MOCK_WRITE <file> in the prompt → writes that file in the workspace
 *   MOCK_KILL in the prompt → SIGKILLs itself mid-run (like the OOM killer)
 *   MOCK_PACE_MS (host env) → delay between streamed words, default 120
 */
const SCRIPT = String.raw`
const spec = JSON.parse(process.env.MOCK_SPEC);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // Markers apply to the new request only, never to a ledger briefing in front of it.
  const briefed = spec.prompt.startsWith("You are continuing work");
  const request = briefed ? spec.prompt.slice(spec.prompt.lastIndexOf("New request:\n") + 13) : spec.prompt;
  const slow = request.includes("MOCK_SLOW");
  emit({ kind: "session", id: spec.harness_session_id || "mock-" + spec.run_id });
  emit({ kind: "tool", id: "call_1", name: "shell", args: { command: "ls" }, out: "README.md" });
  if (slow) await sleep(30000);
  if (request.includes("MOCK_KILL")) process.kill(process.pid, "SIGKILL");
  const write = request.match(/MOCK_WRITE (\S+)/);
  if (write) require("node:fs").writeFileSync(write[1], "written by " + spec.model + "\n");
  if (request.includes("MOCK_FAIL")) {
    emit({ kind: "error", message: "mock harness failure" });
    process.exit(3);
  }
  const reply = "[" + spec.model + (spec.effort ? "/" + spec.effort : "") + "] " + (spec.harness_session_id ? "(resumed) " : "") + (briefed ? "(briefed) " : "") + "done: " + request.slice(0, 80);
  // Paced like a real model so clients (and conformance S-09) can observe progressive streaming.
  for (const word of reply.split(/(?<= )/)) {
    emit({ kind: "delta", text: word });
    await sleep(Number(process.env.MOCK_PACE_MS));
  }
  emit({ kind: "done", text: reply });
  emit({ kind: "usage", input: 1200 + spec.prompt.length, output: 80 });
})();
`;

export const mockDriver: Driver = {
  build(spec) {
    return {
      cmd: process.execPath,
      args: ["-e", SCRIPT],
      env: {
        MOCK_PACE_MS: process.env.MOCK_PACE_MS ?? "120",
        MOCK_SPEC: JSON.stringify({
          run_id: spec.run_id,
          prompt: spec.prompt,
          model: spec.model,
          effort: spec.effort,
          harness_session_id: spec.harness_session_id,
        }),
      },
    };
  },
  parser() {
    return {
      line(line) {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return [];
        }
        switch (ev.kind) {
          case "session":
            return [{ type: "session", harness_session_id: ev.id }];
          case "tool":
            return [
              { type: "tool_call", call_id: ev.id, name: ev.name, arguments: JSON.stringify(ev.args) },
              { type: "tool_result", call_id: ev.id, output: ev.out },
            ];
          case "delta":
            return [{ type: "text_delta", text: ev.text }];
          case "done":
            return [{ type: "text_done", text: ev.text }];
          case "usage":
            return [{ type: "usage", input_tokens: ev.input, output_tokens: ev.output }];
          case "error":
            return [{ type: "error", code: "harness_error", message: ev.message }];
          default:
            return [];
        }
      },
      end: () => [],
    };
  },
};
