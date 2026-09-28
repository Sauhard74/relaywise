import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { mkdir, readFile, rm } from "node:fs/promises";
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

  hostCredentials(): Set<string> {
    const creds = new Set<string>();
    try {
      const auth = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8")) as {
        auth_mode?: string;
        OPENAI_API_KEY?: string | null;
      };
      if (auth.auth_mode === "chatgpt") creds.add("CODEX_AUTH_JSON");
      if (auth.OPENAI_API_KEY) creds.add("OPENAI_API_KEY");
    } catch {
      /* no codex login on this host */
    }
    return creds;
  }

  async installed(): Promise<Record<HarnessId, boolean>> {
    const result = { mock: this.enableMock } as Record<HarnessId, boolean>;
    for (const [id, bin] of Object.entries(BINS)) {
      result[id as HarnessId] = spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
    }
    return result;
  }

  async ensureSandbox(sessionId: string, _existing: string | null, projectId: string | null): Promise<Sandbox> {
    const cwd = projectId ? this.projectDir(projectId) : join(this.workspacesDir, sessionId);
    await mkdir(cwd, { recursive: true });
    return { id: sessionId, cwd };
  }

  async readProjectFile(projectId: string, relPath: string): Promise<string | null> {
    return readFile(join(this.projectDir(projectId), relPath), "utf8").catch(() => null);
  }

  async destroyProject(projectId: string): Promise<void> {
    await rm(this.projectDir(projectId), { recursive: true, force: true });
  }

  private projectDir(projectId: string): string {
    return join(this.workspacesDir, "projects", projectId);
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
