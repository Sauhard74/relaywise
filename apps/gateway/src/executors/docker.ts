import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HarnessId, RunEvent } from "@jev-route/core";
import { SandboxError, type Executor, type RunHandle, type RunStatus, type Sandbox } from "./types.ts";

export interface DockerOptions {
  image: string;
  network: string;
  cpus: string;
  memory: string;
  enableMock: boolean;
  docker?: string;
}

const WORKDIR = "/home/agent/workspace";

/**
 * One container per session, created from the agent-runtime image. The session's home
 * (workspace + harness session state) lives on a named volume, so an idle container can be
 * removed and recreated later without losing files. Credentials travel in the RunSpec over
 * stdin — never as container env or args, so they don't show up in `docker inspect`.
 */
export class DockerExecutor implements Executor {
  readonly kind = "docker" as const;
  private installedCache?: Promise<Record<HarnessId, boolean>>;
  private readonly bin: string;

  constructor(private readonly opts: DockerOptions) {
    this.bin = opts.docker ?? "docker";
  }

  installed(): Promise<Record<HarnessId, boolean>> {
    this.installedCache ??= this.exec(["run", "--rm", "--entrypoint", "agentd", this.opts.image, "check"])
      .then((out) => ({ ...(JSON.parse(out) as Record<HarnessId, boolean>), mock: this.opts.enableMock }))
      .catch((err) => {
        this.installedCache = undefined;
        throw new SandboxError(`cannot inspect image ${this.opts.image}: ${(err as Error).message}`);
      });
    return this.installedCache;
  }

  async ensureSandbox(sessionId: string, existingId: string | null): Promise<Sandbox> {
    const name = containerName(sessionId);
    const state = await this.exec(["inspect", "-f", "{{.State.Running}}", existingId ?? name]).catch(() => undefined);
    if (state?.trim() === "true") return { id: existingId ?? name, cwd: WORKDIR };
    if (state?.trim() === "false") {
      await this.exec(["start", existingId ?? name]);
      return { id: existingId ?? name, cwd: WORKDIR };
    }
    const id = (
      await this.exec([
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `jev-route.session=${sessionId}`,
        "--cpus",
        this.opts.cpus,
        "--memory",
        this.opts.memory,
        "--pids-limit",
        "1024",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--network",
        this.opts.network,
        "-v",
        `${volumeName(sessionId)}:/home/agent`,
        this.opts.image,
      ])
    ).trim();
    return { id: id || name, cwd: WORKDIR };
  }

  run(sandbox: Sandbox, spec: Parameters<Executor["run"]>[1], onEvent: (e: RunEvent) => void): RunHandle {
    const child = spawn(this.bin, ["exec", "-i", "-w", sandbox.cwd, sandbox.id, "agentd", "run"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(JSON.stringify(spec));

    let stderr = "";
    let exitStatus: RunStatus | undefined;
    child.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-2000);
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      let ev: RunEvent;
      try {
        ev = JSON.parse(line) as RunEvent;
      } catch {
        return;
      }
      if (ev.type === "exit") exitStatus = ev.status;
      onEvent(ev);
    });

    const done = new Promise<RunStatus>((resolve) => {
      child.on("error", (err) => {
        onEvent({ type: "error", code: "sandbox_unavailable", message: err.message });
        onEvent({ type: "exit", status: "failed", exit_code: null });
        resolve("failed");
      });
      child.on("close", (code) => {
        if (exitStatus) return resolve(exitStatus);
        onEvent({
          type: "error",
          code: "sandbox_unavailable",
          message: `docker exec ended (code ${code}) without a result${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        });
        onEvent({ type: "exit", status: "failed", exit_code: code });
        resolve("failed");
      });
    });

    return {
      done,
      cancel: async () => {
        await this.exec(["exec", sandbox.id, "agentd", "cancel", spec.run_id]).catch(() => undefined);
      },
    };
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    await this.exec(["rm", "-f", sandboxId]).catch(() => undefined);
  }

  async destroySandbox(sessionId: string, sandboxId: string | null): Promise<void> {
    await this.exec(["rm", "-f", sandboxId ?? containerName(sessionId)]).catch(() => undefined);
    await this.exec(["volume", "rm", "-f", volumeName(sessionId)]).catch(() => undefined);
  }

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new SandboxError(`docker ${args[0]} failed: ${err.trim() || `exit ${code}`}`)),
      );
    });
  }
}

function containerName(sessionId: string): string {
  return `jev-route-${sessionId.replace(/[^\w.-]/g, "")}`;
}

function volumeName(sessionId: string): string {
  return `jev-route-${sessionId.replace(/[^\w.-]/g, "")}`;
}
