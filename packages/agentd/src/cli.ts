#!/usr/bin/env node
/**
 * agentd — runs inside the sandbox.
 *   agentd run            RunSpec JSON on stdin → normalized RunEvent NDJSON on stdout
 *   agentd cancel <id>    stop a running `agentd run` (idempotent)
 *   agentd check          JSON map of which harness CLIs are installed
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSpec } from "@relaywise/core";
import { runHarness } from "./run.ts";

const STATE_DIR = process.env.AGENTD_STATE_DIR ?? join(tmpdir(), "agentd");
const pidFile = (runId: string) => join(STATE_DIR, `${runId.replace(/[^\w-]/g, "_")}.pid`);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function run(): Promise<void> {
  const spec = JSON.parse(await readStdin()) as RunSpec;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(pidFile(spec.run_id), String(process.pid));
  const controller = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => controller.abort());
  try {
    const status = await runHarness(spec, (e) => process.stdout.write(`${JSON.stringify(e)}\n`), controller.signal);
    process.exitCode = status === "completed" ? 0 : status === "cancelled" ? 130 : 1;
  } finally {
    rmSync(pidFile(spec.run_id), { force: true });
  }
}

function cancel(runId: string | undefined): void {
  if (!runId) throw new Error("usage: agentd cancel <run_id>");
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile(runId), "utf8"));
  } catch {
    return; // not running: cancel is idempotent
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already exited */
  }
}

function check(): void {
  const bins = { "claude-code": "claude", codex: "codex", opencode: "opencode", hermes: "hermes" };
  const result: Record<string, boolean> = { mock: true };
  for (const [id, bin] of Object.entries(bins)) {
    result[id] = spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "run") await run();
  else if (cmd === "cancel") cancel(arg);
  else if (cmd === "check") check();
  else {
    process.stderr.write("usage: agentd run | agentd cancel <run_id> | agentd check\n");
    process.exitCode = 2;
  }
} catch (err) {
  process.stderr.write(`agentd: ${(err as Error).message}\n`);
  process.exitCode = 2;
}
