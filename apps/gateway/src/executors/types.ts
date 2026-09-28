import type { HarnessId, RunEvent, RunSpec } from "@jev-route/core";

export type RunStatus = "completed" | "failed" | "cancelled";

export interface RunHandle {
  done: Promise<RunStatus>;
  cancel(): Promise<void>;
}

export interface Sandbox {
  id: string;
  /** Working directory inside the sandbox. */
  cwd: string;
}

export interface Executor {
  readonly kind: "docker" | "local";
  /** Which harness CLIs this executor can run. */
  installed(): Promise<Record<HarnessId, boolean>>;
  /** Returns a running sandbox for the session, creating or restarting it as needed. */
  ensureSandbox(sessionId: string, existingId: string | null): Promise<Sandbox>;
  run(sandbox: Sandbox, spec: RunSpec, onEvent: (e: RunEvent) => void): RunHandle;
  /** Frees compute but keeps the session's files (idle reaping). */
  stopSandbox(sandboxId: string): Promise<void>;
  /** Removes the sandbox and its files (session expiry). */
  destroySandbox(sessionId: string, sandboxId: string | null): Promise<void>;
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}
