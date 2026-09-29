import type { HarnessId, RunEvent, RunSpec } from "@relaywise/core";

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
  /** Credentials satisfied by the host's own CLI logins (local executor only). */
  hostCredentials?(): Set<string>;
  /** Which harness CLIs this executor can run. */
  installed(): Promise<Record<HarnessId, boolean>>;
  /**
   * Returns a running sandbox for the session, creating or restarting it as needed. With a
   * project, the workspace is the project's persistent one (files, git history, .relay/ ledger).
   */
  ensureSandbox(sessionId: string, existingId: string | null, projectId: string | null): Promise<Sandbox>;
  /** Reads a file from a project's workspace; null if the project or file doesn't exist. */
  readProjectFile(projectId: string, relPath: string): Promise<string | null>;
  /** Runs a bash script in the project's workspace (created if missing), with optional stdin. */
  projectShell(projectId: string, script: string, stdin?: Buffer): Promise<Buffer>;
  /** Deletes a project's workspace permanently. */
  destroyProject(projectId: string): Promise<void>;
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
