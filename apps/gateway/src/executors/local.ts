import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessId } from "@jev-route/core";
import { runHarness } from "@jev-route/agentd";
import type { Executor, RunHandle, Sandbox } from "./types.ts";

const BINS: Record<Exclude<HarnessId, "mock">, string> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  hermes: "hermes",
};

/**
 * Runs harnesses as host processes in per-session directories. No isolation — for local
 * development and tests only. Harnesses see the host HOME, so existing CLI logins work.
 */
export class LocalExecutor implements Executor {
  readonly kind = "local" as const;

  constructor(
    private readonly workspacesDir: string,
    private readonly enableMock: boolean,
  ) {}

  async installed(): Promise<Record<HarnessId, boolean>> {
    const result = { mock: this.enableMock } as Record<HarnessId, boolean>;
    for (const [id, bin] of Object.entries(BINS)) {
      result[id as HarnessId] = spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
    }
    return result;
  }

  async ensureSandbox(sessionId: string): Promise<Sandbox> {
    const cwd = join(this.workspacesDir, sessionId);
    await mkdir(cwd, { recursive: true });
    return { id: sessionId, cwd };
  }

  run(_sandbox: Sandbox, spec: Parameters<Executor["run"]>[1], onEvent: Parameters<Executor["run"]>[2]): RunHandle {
    const controller = new AbortController();
    return {
      done: runHarness(spec, onEvent, controller.signal),
      cancel: async () => controller.abort(),
    };
  }

  async stopSandbox(): Promise<void> {}

  async destroySandbox(sessionId: string): Promise<void> {
    await rm(join(this.workspacesDir, sessionId), { recursive: true, force: true });
  }
}
