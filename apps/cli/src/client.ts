/** Thin client for the relaywise gateway. */

export interface RouteDecision {
  harness: string;
  model: string;
  effort?: string;
  option_id: string;
  source: string;
  objective: string;
  features: { task_type: string; difficulty: number };
  est_cost_usd: number;
  baseline_est_cost_usd?: number;
  latency_ms: number;
  reason: string;
  fallback_reason?: string;
  handoff?: boolean;
  candidates: { option_id: string; score: number; est_cost_usd: number }[];
}

export interface Checkpoint {
  turn: number;
  commit: string | null;
  files: { status: string; path: string }[];
  summary: string;
}

export interface ResponseObject {
  id: string;
  status: "in_progress" | "completed" | "failed" | "incomplete" | "cancelled";
  model: string;
  output_text: string;
  error: { code: string; message: string } | null;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  metadata: {
    session_id: string;
    project_id?: string;
    harness_id: string;
    reasoning_effort?: string;
    route?: RouteDecision;
    cost_usd?: number;
    duration_ms?: number;
    checkpoint?: Checkpoint;
  };
}

export type StreamEvent =
  | { type: "created"; response: ResponseObject }
  | { type: "text"; delta: string }
  | { type: "message_done" }
  | { type: "reasoning" }
  | { type: "tool"; name: string; args: string }
  | { type: "tool_result"; output: string }
  | { type: "done"; response: ResponseObject };

export interface Settings {
  harness: string;
  model?: string;
  effort?: string;
  objective: "cheapest" | "balanced" | "best";
  budget?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class Gateway {
  constructor(
    readonly url: string,
    private readonly key?: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}), ...extra };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, { ...init, headers: this.headers(init.headers as Record<string, string>) });
    } catch (err) {
      throw new ApiError(`cannot reach the relaywise gateway at ${this.url} — start it with \`relay up\``, 0);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
      throw new ApiError(body.error?.message ?? `HTTP ${res.status}`, res.status, body.error?.code);
    }
    return res;
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.request(path, init)).json()) as T;
  }

  async text(path: string): Promise<string> {
    return (await this.request(path)).text();
  }

  harnesses() {
    return this.json<{ harnesses: { base: string; name: string; available: boolean; unavailable_reasons?: string[]; routing?: { engine: string; model: string } }[] }>(
      "/v1/harnesses",
    );
  }

  route(prompt: string, s: Settings, project?: string) {
    return this.json<RouteDecision>("/v1/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.body(prompt, s, project)),
    });
  }

  async sync(project: string, tar: Buffer) {
    return this.json<{ head: string; files_changed: number }>(`/v1/projects/${project}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/x-tar" },
      body: new Uint8Array(tar),
    });
  }

  diff(project: string, commit: string) {
    return this.text(`/v1/projects/${project}/diff?commit=${commit}`);
  }

  memory(project: string, turn?: number) {
    return this.text(`/v1/projects/${project}/memory${turn ? `?turn=${turn}` : ""}`);
  }

  cancel(id: string) {
    return this.json<ResponseObject>(`/v1/responses/${id}/cancel`, { method: "POST" });
  }

  stats() {
    return this.json<{ totals: { runs: number; completed: number; cost_usd: number }; savings: { saved_usd: number; runs_counted: number } }>(
      "/v1/stats",
    );
  }

  private body(prompt: string, s: Settings, project?: string, previous?: string) {
    return {
      input: prompt,
      ...(s.model ? { model: s.model } : {}),
      ...(previous ? { previous_response_id: previous } : {}),
      ...(s.effort ? { reasoning: { effort: s.effort } } : {}),
      routing: { objective: s.objective, ...(s.budget ? { max_cost_usd: s.budget } : {}) },
      metadata: { harness_id: s.harness, ...(project ? { project_id: project } : {}) },
    };
  }

  /** Runs a turn, yielding simplified stream events. */
  async *run(
    prompt: string,
    s: Settings,
    opts: { project?: string; previous?: string; signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent> {
    const res = await this.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...this.body(prompt, s, opts.project, opts.previous), stream: true }),
      signal: opts.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const e = JSON.parse(line.slice(6)) as { type: string; [k: string]: any };
        switch (e.type) {
          case "response.created":
            yield { type: "created", response: e.response };
            break;
          case "response.output_text.delta":
            yield { type: "text", delta: e.delta };
            break;
          case "response.output_item.done":
            if (e.item.type === "message") yield { type: "message_done" };
            if (e.item.type === "function_call") yield { type: "tool", name: e.item.name, args: e.item.arguments };
            if (e.item.type === "function_call_output") yield { type: "tool_result", output: e.item.output };
            break;
          case "response.reasoning_summary_text.delta":
            yield { type: "reasoning" };
            break;
          case "response.completed":
          case "response.failed":
          case "response.incomplete":
            yield { type: "done", response: e.response };
            return;
        }
      }
    }
  }
}
