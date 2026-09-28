import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { makeRedactor, type HarnessId, type RunEvent, type RunSpec } from "@jev-route/core";
import type { Driver } from "./driver.ts";
import { claudeDriver } from "./drivers/claude.ts";
import { codexDriver } from "./drivers/codex.ts";
import { hermesDriver } from "./drivers/hermes.ts";
import { mockDriver } from "./drivers/mock.ts";
import { opencodeDriver } from "./drivers/opencode.ts";

export const DRIVERS: Record<HarnessId, Driver> = {
  "claude-code": claudeDriver,
  codex: codexDriver,
  opencode: opencodeDriver,
  hermes: hermesDriver,
  mock: mockDriver,
};

/** Only these host variables reach a harness; everything else must come through spec.env. */
const BASE_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "SHELL", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 3_000;
const STDERR_TAIL = 4_000;

export type RunStatus = "completed" | "failed" | "cancelled";

export async function runHarness(
  spec: RunSpec,
  emit: (event: RunEvent) => void,
  signal?: AbortSignal,
): Promise<RunStatus> {
  const redact = makeRedactor(Object.values(spec.env));
  const out = (e: RunEvent) => emit(redactEvent(e, redact));
  const driver = DRIVERS[spec.harness];
  if (!driver) {
    out({ type: "error", code: "unknown_harness", message: `unknown harness '${spec.harness}'` });
    out({ type: "exit", status: "failed", exit_code: null });
    return "failed";
  }

  const command = driver.build(spec);
  await mkdir(spec.cwd, { recursive: true });
  for (const [path, content] of Object.entries(command.files ?? {})) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  const env: Record<string, string> = {};
  for (const k of BASE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k]!;
  Object.assign(env, spec.env, command.env, { TERM: "dumb", CI: "1" });

  const child = spawn(command.cmd, command.args, {
    cwd: spec.cwd,
    env,
    detached: true, // own process group so cancel kills the harness's children too
    stdio: ["ignore", "pipe", "pipe"],
  });

  let spawnError: NodeJS.ErrnoException | undefined;
  let sawError = false;
  let reason: "timeout" | "cancelled" | undefined;
  let stderr = "";

  const killGroup = (sig: NodeJS.Signals) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  const stop = (why: "timeout" | "cancelled") => {
    if (reason) return;
    reason = why;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
  };

  const timer = setTimeout(() => stop("timeout"), spec.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  timer.unref();
  const onAbort = () => stop("cancelled");
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });

  child.on("error", (err) => {
    spawnError = err;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
  });

  out({ type: "started", harness: spec.harness, model: spec.model, ...(child.pid ? { pid: child.pid } : {}) });

  const parser = driver.parser(spec);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const forward = (events: RunEvent[]) => {
    for (const e of events) {
      if (e.type === "error") sawError = true;
      out(e);
    }
  };
  lines.on("line", (line) => {
    try {
      forward(parser.line(line));
    } catch (err) {
      forward([{ type: "error", code: "parse_error", message: (err as Error).message }]);
    }
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);

  if (spawnError) {
    const missing = spawnError.code === "ENOENT";
    forward([
      {
        type: "error",
        code: missing ? "harness_not_installed" : "spawn_failed",
        message: missing ? `'${command.cmd}' is not installed in this sandbox` : spawnError.message,
      },
    ]);
  } else if (reason !== "cancelled") {
    forward(await parser.end(exitCode));
  }

  let status: RunStatus;
  if (reason === "cancelled") status = "cancelled";
  else if (reason === "timeout") {
    forward([{ type: "error", code: "timeout", message: `run exceeded ${spec.timeout_ms ?? DEFAULT_TIMEOUT_MS} ms` }]);
    status = "failed";
  } else if (spawnError || sawError || (exitCode !== 0 && exitCode !== null)) {
    status = "failed";
    if (!sawError) {
      forward([
        {
          type: "error",
          code: "harness_exit",
          message: `harness exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(-800)}` : ""}`,
        },
      ]);
    }
  } else status = "completed";

  out({ type: "exit", status, exit_code: exitCode });
  return status;
}

function redactEvent(e: RunEvent, redact: (s: string) => string): RunEvent {
  switch (e.type) {
    case "text_delta":
    case "text_done":
    case "reasoning":
      return { ...e, text: redact(e.text) };
    case "tool_call":
      return { ...e, arguments: redact(e.arguments) };
    case "tool_result":
      return { ...e, output: redact(e.output) };
    case "error":
    case "notice":
      return { ...e, message: redact(e.message) };
    default:
      return e;
  }
}
