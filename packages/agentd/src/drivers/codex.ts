import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "@jev-route/core";
import { parseJsonLine, promptArg, type Driver } from "../driver.ts";

/** Codex headless: `codex exec --json`. Resume via `codex exec resume <thread_id>`. */
export const codexDriver: Driver = {
  build(spec) {
    // `exec resume` accepts a subset of `exec` flags (no --color / --cd); it runs in the spawn cwd.
    const resume = spec.harness_session_id;
    const args = resume ? ["exec", "resume"] : ["exec", "--color", "never", "--cd", spec.cwd];
    args.push(
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      spec.model,
      "-c",
      'approval_policy="never"',
    );
    if (spec.effort) args.push("-c", `model_reasoning_effort="${spec.effort}"`);
    if (resume) args.push(resume);
    args.push(promptArg(spec.prompt));

    const auth = spec.env.CODEX_AUTH_JSON;
    if (!auth) return { cmd: "codex", args };
    // ChatGPT login: a private CODEX_HOME outside the workspace, so the agent's own file tools
    // don't wander into it. Codex refreshes tokens in place; keep a copy that is newer than ours.
    const home = join(process.env.HOME ?? spec.cwd, ".jev-route", "codex");
    const authPath = join(home, "auth.json");
    const files = isNewer(authPath, auth) ? {} : { [authPath]: auth };
    return { cmd: "codex", args, env: { CODEX_HOME: home, CODEX_AUTH_JSON: "" }, files };
  },

  parser() {
    let sawTerminal = false;
    return {
      line(line) {
        const ev = parseJsonLine(line);
        if (!ev) return [];
        const out: RunEvent[] = [];
        const item = ev.item ?? {};
        switch (ev.type) {
          case "thread.started":
            if (ev.thread_id) out.push({ type: "session", harness_session_id: String(ev.thread_id) });
            break;
          case "item.started":
            if (item.type === "command_execution") {
              out.push(call(item.id, "shell", { command: item.command }));
            }
            break;
          case "item.completed":
            switch (item.type) {
              case "agent_message":
                if (item.text) out.push({ type: "text_done", text: String(item.text) });
                break;
              case "reasoning":
                if (item.text) out.push({ type: "reasoning", text: String(item.text) });
                break;
              case "command_execution":
                out.push({
                  type: "tool_result",
                  call_id: String(item.id),
                  output: String(item.aggregated_output ?? ""),
                  ...(item.exit_code && item.exit_code !== 0 ? { is_error: true } : {}),
                });
                break;
              case "file_change":
                out.push(call(item.id, "apply_patch", { changes: item.changes ?? [] }));
                out.push({ type: "tool_result", call_id: String(item.id), output: String(item.status ?? "completed") });
                break;
              case "mcp_tool_call":
                out.push(call(item.id, `${item.server}.${item.tool}`, item.arguments ?? {}));
                out.push({
                  type: "tool_result",
                  call_id: String(item.id),
                  output: JSON.stringify(item.result ?? item.error ?? null),
                  ...(item.error ? { is_error: true } : {}),
                });
                break;
              case "web_search":
                out.push(call(item.id, "web_search", { query: item.query }));
                out.push({ type: "tool_result", call_id: String(item.id), output: "" });
                break;
              case "error":
                // Codex reports warnings as error items; only a failed turn is fatal.
                out.push({ type: "notice", message: String(item.message ?? "codex warning") });
                break;
            }
            break;
          case "turn.completed": {
            sawTerminal = true;
            const u = ev.usage ?? {};
            const cached = u.cached_input_tokens ?? 0;
            out.push({
              type: "usage",
              input_tokens: Math.max(0, (u.input_tokens ?? 0) - cached),
              output_tokens: u.output_tokens ?? 0,
              cache_read_tokens: cached,
            });
            break;
          }
          case "turn.failed":
            sawTerminal = true;
            out.push({ type: "error", code: "turn_failed", message: String(ev.error?.message ?? "codex turn failed") });
            break;
          case "error":
            out.push({ type: "notice", message: String(ev.message ?? "codex warning") });
            break;
        }
        return out;
      },
      end(exitCode) {
        return !sawTerminal && exitCode !== 0
          ? [{ type: "error", code: "harness_exit", message: `codex exited with code ${exitCode}` }]
          : [];
      },
    };
  },
};

function isNewer(path: string, incoming: string): boolean {
  try {
    const current = JSON.parse(readFileSync(path, "utf8")) as { last_refresh?: string };
    const next = JSON.parse(incoming) as { last_refresh?: string };
    return Boolean(current.last_refresh && next.last_refresh && current.last_refresh >= next.last_refresh);
  } catch {
    return false;
  }
}

function call(id: unknown, name: string, args: unknown): RunEvent {
  return { type: "tool_call", call_id: String(id), name, arguments: JSON.stringify(args) };
}
