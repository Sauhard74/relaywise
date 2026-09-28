import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "@jev-route/core";
import { promptArg, withTranscript, type Driver } from "../driver.ts";

/**
 * Hermes Agent one-shot mode: `hermes -z <prompt> --usage-file f`.
 * Hermes has no JSON event stream, so stdout is streamed as text and usage is read from the
 * usage file afterwards. Continuation replays the transcript (no reliable native resume id).
 */
export const hermesDriver: Driver = {
  build(spec) {
    const home = join(spec.cwd, ".harness", "hermes");
    return {
      cmd: "hermes",
      args: [
        "-z",
        promptArg(withTranscript(spec)),
        "--provider",
        "openrouter",
        "--model",
        spec.model,
        "--usage-file",
        usageFile(spec.cwd, spec.run_id),
        "--yolo", // no approval prompts: the container is the sandbox
      ],
      env: { HERMES_HOME: home, NO_COLOR: "1" },
    };
  },

  parser(spec) {
    let text = "";
    return {
      line(line) {
        if (!text && !line.trim()) return [];
        const chunk = `${line}\n`;
        text += chunk;
        return [{ type: "text_delta", text: chunk }];
      },
      async end(exitCode) {
        const out: RunEvent[] = [];
        if (text.trim()) out.push({ type: "text_done", text: text.trimEnd() });
        const usage = await readUsage(usageFile(spec.cwd, spec.run_id));
        out.push(...usage);
        if (exitCode !== 0 && exitCode !== null && !usage.some((e) => e.type === "error")) {
          out.push({ type: "error", code: "harness_exit", message: `hermes exited with code ${exitCode}` });
        }
        return out;
      },
    };
  },
};

function usageFile(cwd: string, runId: string): string {
  return join(cwd, ".harness", `hermes-usage-${runId}.json`);
}

/** Shape written by hermes_cli/oneshot.py `_write_usage_file` (v0.19). */
interface HermesUsage {
  estimated_cost_usd?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  reasoning_tokens?: number | null;
  failed?: boolean;
  failure?: string;
}

async function readUsage(path: string): Promise<RunEvent[]> {
  let u: HermesUsage;
  try {
    u = JSON.parse(await readFile(path, "utf8")) as HermesUsage;
  } catch {
    return [];
  }
  const out: RunEvent[] = [];
  if (u.input_tokens != null || u.output_tokens != null) {
    out.push({
      type: "usage",
      input_tokens: (u.input_tokens ?? 0) + (u.cache_write_tokens ?? 0),
      output_tokens: (u.output_tokens ?? 0) + (u.reasoning_tokens ?? 0),
      cache_read_tokens: u.cache_read_tokens ?? 0,
      ...(typeof u.estimated_cost_usd === "number" ? { cost_usd: u.estimated_cost_usd } : {}),
    });
  }
  if (u.failed) out.push({ type: "error", code: "harness_error", message: u.failure ?? "hermes run failed" });
  return out;
}
