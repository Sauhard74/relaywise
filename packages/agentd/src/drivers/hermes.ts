import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "@jev-route/core";
import { withTranscript, type Driver } from "../driver.ts";

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
        withTranscript(spec),
        "--provider",
        "openrouter",
        "--model",
        spec.model,
        "--usage-file",
        usageFile(spec.cwd, spec.run_id),
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
        if (usage) out.push(usage);
        if (exitCode !== 0 && exitCode !== null) {
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

async function readUsage(path: string): Promise<RunEvent | undefined> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const flat = flatten(raw);
  const pick = (re: RegExp) => Object.entries(flat).find(([k, v]) => re.test(k) && typeof v === "number")?.[1] as number | undefined;
  const input = pick(/(^|\.)(input|prompt)_tokens$/);
  const output = pick(/(^|\.)(output|completion)_tokens$/);
  if (input === undefined && output === undefined) return undefined;
  const cost = pick(/(^|\.)(total_)?cost(_usd)?$/);
  return {
    type: "usage",
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    ...(cost !== undefined ? { cost_usd: cost } : {}),
  };
}

function flatten(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v as Record<string, unknown>, key));
    else out[key] = v;
  }
  return out;
}
