/**
 * Minimal client for TypeSafe's System One API (Jev).
 * Raw fetch so the routing deadline is enforced with one AbortSignal.
 * Works against any wire-compatible server (e.g. OpenJev) via baseUrl.
 */

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | {
      type: "score";
      /** Probability-weighted 0-based level index. */
      score: number;
      confidence: number;
      legend?: Record<string, string>;
      probabilities?: Record<string, number>;
    }
  | { type: "noul"; noul: number };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export class JevClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: JevClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, "");
    this.model = opts.model ?? "jev-latest";
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async ask(
    state: string | Record<string, unknown>,
    questions: Record<string, JevQuestion>,
    signal?: AbortSignal,
  ): Promise<JevResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: this.model, questions }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new JevError("jev deadline exceeded");
      throw new JevError(`jev request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new JevError(`jev HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
    }
    const json = (await res.json()) as JevResponse;
    if (!json || typeof json.answers !== "object") throw new JevError("jev response missing answers");
    return json;
  }
}
