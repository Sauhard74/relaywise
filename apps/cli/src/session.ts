import { Gateway, type ResponseObject, type Settings, type StreamEvent } from "./client.ts";
import { applyPatch, listFiles, patchStats, tarFiles, type PatchStats } from "./workspace.ts";

export interface TurnResult {
  response: ResponseObject;
  patch?: string;
  stats?: PatchStats;
  applyError?: string;
}

export type Phase = { kind: "syncing"; files: number } | { kind: "running" } | { kind: "applying" };

/** One `jev` conversation: consecutive turns share a session; `/new` starts another. */
export class Session {
  previous?: string;
  lastPatch?: string;
  private controller?: AbortController;
  private runningId?: string;

  constructor(
    readonly gateway: Gateway,
    readonly cwd: string,
    readonly project: string,
    public settings: Settings,
    public sync = true,
  ) {}

  reset(): void {
    this.previous = undefined;
  }

  async turn(prompt: string, onEvent: (e: StreamEvent) => void, onPhase: (p: Phase) => void): Promise<TurnResult> {
    if (this.sync) {
      const files = await listFiles(this.cwd);
      onPhase({ kind: "syncing", files: files.length });
      await this.gateway.sync(this.project, await tarFiles(this.cwd, files));
    }
    onPhase({ kind: "running" });
    this.controller = new AbortController();
    let final: ResponseObject | undefined;
    try {
      for await (const e of this.gateway.run(prompt, this.settings, {
        project: this.project,
        previous: this.previous,
        signal: this.controller.signal,
      })) {
        if (e.type === "created") this.runningId = e.response.id;
        if (e.type === "done") final = e.response;
        onEvent(e);
      }
    } finally {
      this.controller = undefined;
      this.runningId = undefined;
    }
    if (!final) throw new Error("the stream ended without a result");
    // Failed turns aren't continued from; the session itself stays usable.
    if (final.status === "completed" || final.status === "incomplete") this.previous = final.id;

    const result: TurnResult = { response: final };
    const commit = final.metadata.checkpoint?.commit;
    if (this.sync && commit && final.metadata.checkpoint!.files.length > 0) {
      onPhase({ kind: "applying" });
      const patch = await this.gateway.diff(this.project, commit);
      if (patch.trim()) {
        result.patch = patch;
        result.stats = patchStats(patch);
        try {
          await applyPatch(this.cwd, patch);
          this.lastPatch = patch;
        } catch (err) {
          result.applyError = (err as Error).message;
        }
      }
    }
    return result;
  }

  /** Stops the running turn; the gateway marks it cancelled. */
  async cancel(): Promise<void> {
    const id = this.runningId;
    if (id) await this.gateway.cancel(id).catch(() => undefined);
  }

  get running(): boolean {
    return this.controller !== undefined;
  }

  async undo(): Promise<PatchStats | null> {
    if (!this.lastPatch) return null;
    await applyPatch(this.cwd, this.lastPatch, true);
    const stats = patchStats(this.lastPatch);
    this.lastPatch = undefined;
    return stats;
  }
}
